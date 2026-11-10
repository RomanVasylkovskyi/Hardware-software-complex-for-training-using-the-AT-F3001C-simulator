"""
FastAPI Analytics Service for AT-F3001C Flight Simulator.
Evaluates:
- ICAO DOC 8168 & FAA AC 120-108 Stabilized Approach
- Landing Score Physics (Touchdown vertical speed, G-force, Centerline offset)
- AI Flight Envelope & GPWS Warnings
Port: 8003.
"""

from __future__ import annotations

import asyncio
import csv
import json
import logging
import os
import sys
import time
from typing import Any, Dict, List, Optional

# Ensure service directory is on sys.path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import uvicorn
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from landing_score import LandingScoreEvaluator
from stabilized_approach import StabilizedApproachMonitor

try:
    from ai_warnings import FlightWarningsGenerator
except ImportError:
    from warnings import FlightWarningsGenerator

logger = logging.getLogger("analytics_service")
logging.basicConfig(level=logging.INFO)

app = FastAPI(
    title="AT-F3001C Flight Analytics Service",
    description="Real-time Flight Analytics, ICAO Stabilized Approach Monitoring, and Touchdown Physics Scorer",
    version="1.0.0",
)

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Airport runway database for automatic GPS centerline alignment
AIRPORT_RUNWAY_DB: Dict[str, Dict[str, Any]] = {
    "UKLL:13": {
        "threshold_lat": 49.81482,
        "threshold_lon": 23.95450,
        "heading_deg": 130.0,
        "airport_name": "Lviv Danylo Halytskyi International Airport",
    }
}

airport_icao = os.getenv("AIRPORT_ICAO", "UKLL").upper()
runway_ident = os.getenv("RUNWAY_IDENT", "13")
rwy_key = f"{airport_icao}:{runway_ident}"
rwy_info = AIRPORT_RUNWAY_DB.get(rwy_key, {})

# Initialize engines
approach_monitor = StabilizedApproachMonitor(
    default_target_ias_kt=float(os.getenv("TARGET_IAS_KT", 65.0)),
    max_sink_rate_fpm=1000.0,
    max_roll_deg=7.0,
)
landing_evaluator = LandingScoreEvaluator(
    runway_threshold_lat=rwy_info.get("threshold_lat"),
    runway_threshold_lon=rwy_info.get("threshold_lon"),
    runway_heading_deg=rwy_info.get("heading_deg"),
)
warnings_generator = FlightWarningsGenerator(
    default_target_ias_kt=float(os.getenv("TARGET_IAS_KT", 65.0)),
)


class TelemetryFrame(BaseModel):
    time_sec: Optional[float] = None
    altitude_agl_ft: Optional[float] = None
    altitude_msl_ft: Optional[float] = None
    indicated_airspeed_kt: Optional[float] = None
    vertical_speed_fpm: Optional[float] = None
    roll_deg: Optional[float] = None
    pitch_deg: Optional[float] = None
    heading_deg: Optional[float] = None
    groundspeed_kt: Optional[float] = None
    g_load_normal: Optional[float] = None
    flap_ratio: Optional[float] = None
    gear_ratio: Optional[float] = None
    on_runway: Optional[int] = None
    lateral_offset_m: Optional[float] = None
    centerline_offset_m: Optional[float] = None
    target_ias_kt: Optional[float] = None
    is_vmc: Optional[bool] = False

    model_config = {"extra": "allow"}


class SessionEvaluationRequest(BaseModel):
    frames: Optional[List[Dict[str, Any]]] = Field(None, description="List of telemetry frames")
    csv_file_path: Optional[str] = Field(None, description="Optional path to server-side telemetry CSV file")
    target_ias_kt: Optional[float] = Field(None, description="Optional target IAS in knots")
    is_vmc: Optional[bool] = Field(False, description="Whether visual meteorological conditions apply")


@app.get("/health")
@app.get("/analytics/status")
async def get_status() -> Dict[str, Any]:
    """Operational health check and engine parameters."""
    return {
        "status": "ONLINE",
        "service": "analytics-service",
        "port": 8003,
        "standards": ["ICAO DOC 8168", "FAA AC 120-108"],
        "parameters": {
            "target_ias_kt": approach_monitor.default_target_ias_kt,
            "max_sink_rate_below_1000ft_fpm": approach_monitor.max_sink_rate_fpm,
            "max_roll_on_final_deg": approach_monitor.max_roll_deg,
        },
        "timestamp": time.time(),
    }


@app.post("/analytics/evaluate")
async def evaluate_single_frame(telemetry: Dict[str, Any]) -> Dict[str, Any]:
    """
    Evaluate single telemetry sample:
    1. ICAO/FAA approach stabilization status
    2. Real-time warnings (SINK RATE, PULL UP, GLIDESLOPE, TOO HIGH SPEED, etc.)
    3. Landing score (evaluates touchdown if on runway, else NO_TOUCHDOWN_YET)
    """
    target_ias = telemetry.get("target_ias_kt")
    is_vmc = bool(telemetry.get("is_vmc", False))

    stability_result = approach_monitor.evaluate_frame(
        telemetry, target_ias_kt=target_ias, is_vmc=is_vmc
    )
    warnings_result = warnings_generator.evaluate_warnings(
        telemetry, target_ias_kt=target_ias
    )
    landing_result = landing_evaluator.evaluate_frame(telemetry)

    return {
        "timestamp": telemetry.get("time_sec", time.time()),
        "stabilized_approach": stability_result,
        "warnings": warnings_result,
        "landing_score": landing_result,
    }


@app.post("/analytics/session")
async def evaluate_session(request: SessionEvaluationRequest) -> Dict[str, Any]:
    """
    Evaluate a complete flight session:
    - Finds approach stabilization profile
    - Pinpoints touchdown moment and computes physical Landing Score
    - Aggregates all flight envelope warnings and safety statistics
    """
    frames: List[Dict[str, Any]] = []

    # 1. Load from CSV if requested
    if request.csv_file_path:
        if not os.path.exists(request.csv_file_path):
            raise HTTPException(
                status_code=404,
                detail=f"Telemetry CSV file not found: {request.csv_file_path}",
            )
        try:
            with open(request.csv_file_path, "r", encoding="utf-8") as f:
                reader = csv.DictReader(f)
                frames = [dict(row) for row in reader]
        except Exception as e:
            raise HTTPException(
                status_code=400,
                detail=f"Failed to parse CSV file: {str(e)}",
            )
    elif request.frames:
        frames = request.frames
    else:
        raise HTTPException(
            status_code=400,
            detail="Either 'frames' list or 'csv_file_path' must be provided.",
        )

    if not frames:
        return {
            "status": "EMPTY_SESSION",
            "message": "No telemetry frames available for analysis",
        }

    # 2. Evaluate touchdown score
    landing_result = landing_evaluator.evaluate_flight_session(frames)

    # 3. Evaluate stabilized approach gates (1000 ft IMC and 500 ft VMC)
    gate_1000_frame = None
    gate_500_frame = None

    for frame in frames:
        alt_agl = frame.get("altitude_agl_ft")
        if alt_agl is not None:
            try:
                alt = float(alt_agl)
                if gate_1000_frame is None and alt <= 1000.0:
                    gate_1000_frame = frame
                if gate_500_frame is None and alt <= 500.0:
                    gate_500_frame = frame
            except (ValueError, TypeError):
                continue

    stability_at_1000ft = (
        approach_monitor.evaluate_frame(
            gate_1000_frame, target_ias_kt=request.target_ias_kt, is_vmc=False
        )
        if gate_1000_frame
        else {"status": "AIRCRAFT_DID_NOT_PASS_1000FT_GATE"}
    )

    stability_at_500ft = (
        approach_monitor.evaluate_frame(
            gate_500_frame, target_ias_kt=request.target_ias_kt, is_vmc=True
        )
        if gate_500_frame
        else {"status": "AIRCRAFT_DID_NOT_PASS_500FT_GATE"}
    )

    # 4. Warnings aggregation across session
    warning_timeline: List[Dict[str, Any]] = []
    warning_counts: Dict[str, int] = {}

    for frame in frames:
        res = warnings_generator.evaluate_warnings(
            frame, target_ias_kt=request.target_ias_kt
        )
        if res.get("active_warnings"):
            t = frame.get("time_sec")
            for w in res["active_warnings"]:
                warning_counts[w] = warning_counts.get(w, 0) + 1
            warning_timeline.append({
                "time_sec": t,
                "warnings": res["active_warnings"],
            })

    return {
        "status": "SESSION_EVALUATED",
        "total_data_points": len(frames),
        "landing_score": landing_result,
        "stabilized_approach_gates": {
            "gate_1000ft_imc": stability_at_1000ft,
            "gate_500ft_vmc": stability_at_500ft,
        },
        "warnings_summary": {
            "total_warning_events": len(warning_timeline),
            "counts_by_type": warning_counts,
            "timeline_sample": warning_timeline[:50],  # Return up to first 50 incidents
        },
    }


@app.websocket("/ws/analytics")
async def websocket_analytics_endpoint(websocket: WebSocket) -> None:
    """
    WebSocket endpoint for real-time telemetry streaming and analysis.
    Clients push telemetry frames in JSON format;
    Server returns evaluated stability, warnings, and touchdown scores.
    """
    await websocket.accept()
    logger.info("WebSocket client connected to /ws/analytics")

    try:
        while True:
            data_text = await websocket.receive_text()
            try:
                telemetry = json.loads(data_text)
            except json.JSONDecodeError:
                await websocket.send_text(
                    json.dumps({"error": "INVALID_JSON_PAYLOAD"})
                )
                continue

            target_ias = telemetry.get("target_ias_kt")
            is_vmc = bool(telemetry.get("is_vmc", False))

            stability = approach_monitor.evaluate_frame(
                telemetry, target_ias_kt=target_ias, is_vmc=is_vmc
            )
            warnings = warnings_generator.evaluate_warnings(
                telemetry, target_ias_kt=target_ias
            )
            landing = landing_evaluator.evaluate_frame(telemetry)

            response = {
                "timestamp": telemetry.get("time_sec", time.time()),
                "stabilized_approach": stability,
                "warnings": warnings,
                "landing_score": landing,
            }
            await websocket.send_text(json.dumps(response))
    except WebSocketDisconnect:
        logger.info("WebSocket client disconnected from /ws/analytics")
    except Exception as e:
        logger.error("WebSocket analytics error: %s", e)


if __name__ == "__main__":
    uvicorn.run("server:app", host="0.0.0.0", port=8003, reload=False)
