"""
FastAPI Gateway Aggregator Application.
Unites telemetry-service, vision-service, and analytics-service.
Mounts and serves the Instructor Panel avionics web interface.
"""

import logging
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Dict, Optional

import httpx
from fastapi import FastAPI, File, Form, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

try:
    from .aggregator import StreamAggregator
    from .config import settings
    from .ws_manager import WebSocketManager
except ImportError:
    from aggregator import StreamAggregator
    from config import settings
    from ws_manager import WebSocketManager

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("gateway.main")

# Instantiate core components
aggregator = StreamAggregator(settings)
ws_manager = WebSocketManager(settings, aggregator)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Lifecycle manager for startup and shutdown background tasks."""
    logger.info("Initializing Gateway Service on port %d...", settings.PORT)
    await aggregator.start()
    await ws_manager.start()
    yield
    logger.info("Shutting down Gateway Service...")
    await ws_manager.stop()
    await aggregator.stop()


app = FastAPI(
    title="AT-F3001C Simulator Gateway Service",
    description="Central real-time aggregator and WebSocket gateway for the AT-F3001C flight simulator complex",
    version="1.0.0",
    lifespan=lifespan,
)

# Enable CORS for cross-origin tablet clients
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health", summary="Service Health Check")
async def health_check() -> Dict[str, Any]:
    """Basic health check indicating gateway operational status and microservice reachability."""
    return {
        "status": "ok",
        "service": "gateway-service",
        "service_status": dict(aggregator.service_status),
    }


@app.get("/api/status", summary="Comprehensive Gateway Status")
async def get_system_status() -> Dict[str, Any]:
    """Full diagnostic inspection of aggregator, upstream microservices, and connected clients."""
    return {
        "service": "gateway-service",
        "aggregator": aggregator.get_status_summary(),
        "websocket": ws_manager.get_stats(),
        "airport": {
            "icao": settings.AIRPORT_ICAO,
            "runway": settings.RUNWAY_IDENT,
        },
    }


@app.get("/api/telemetry", summary="Latest Unified Payload Snapshot")
async def get_latest_telemetry() -> Dict[str, Any]:
    """Return the most recent aggregated avionics snapshot."""
    return aggregator.get_unified_payload()


# ================= DATA SOURCE & REPLAY PROXY ENDPOINTS =================

@app.get("/api/replay/status", summary="Get Replay Status")
async def get_replay_status() -> Dict[str, Any]:
    """Proxy query to telemetry-service for active replay status."""
    url = f"{settings.TELEMETRY_HTTP_URL}/replay/status"
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            resp = await client.get(url)
            return resp.json()
    except Exception as e:
        return {"mode": "unknown", "is_running": False, "error": str(e)}


@app.get("/api/replay/files", summary="List Available Replay Files")
async def list_replay_files() -> Dict[str, Any]:
    """Proxy query to telemetry-service for stored flight recordings."""
    url = f"{settings.TELEMETRY_HTTP_URL}/replay/files"
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(url)
            return resp.json()
    except Exception as e:
        return {"files": [], "error": str(e)}


@app.post("/api/replay/start", summary="Start Flight Data Replay")
async def start_replay(payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Proxy command to start replay engine on telemetry-service."""
    url = f"{settings.TELEMETRY_HTTP_URL}/replay/start"
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(url, json=payload or {})
            if resp.status_code != 200:
                raise HTTPException(status_code=resp.status_code, detail=resp.text)
            return resp.json()
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Failed to contact telemetry service: {e}")


@app.post("/api/replay/stop", summary="Stop Flight Data Replay")
async def stop_replay() -> Dict[str, Any]:
    """Proxy command to stop replay engine on telemetry-service."""
    url = f"{settings.TELEMETRY_HTTP_URL}/replay/stop"
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.post(url)
            return resp.json()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Failed to contact telemetry service: {e}")


@app.post("/api/mode/live", summary="Switch to Live UDP Mode")
@app.post("/api/telemetry/mode/live", summary="Switch to Live UDP Mode (alias)")
async def switch_mode_live() -> Dict[str, Any]:
    """Proxy command to switch telemetry-service to online X-Plane UDP ingestion."""
    url = f"{settings.TELEMETRY_HTTP_URL}/telemetry/mode/live"
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.post(url)
            return resp.json()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Failed to switch to live mode: {e}")


@app.post("/api/replay/upload", summary="Upload Flight File and Start Replay")
async def upload_flight_file(
    file: UploadFile = File(...),
    start_immediately: bool = Form(True),
    speed: float = Form(1.0),
    loop: bool = Form(True),
) -> Dict[str, Any]:
    """Proxy multipart file upload from instructor station to telemetry-service."""
    url = f"{settings.TELEMETRY_HTTP_URL}/replay/upload"
    try:
        file_bytes = await file.read()
        files = {"file": (file.filename, file_bytes, file.content_type or "application/octet-stream")}
        data = {
            "start_immediately": "true" if start_immediately else "false",
            "speed": str(speed),
            "loop": "true" if loop else "false",
        }
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(url, files=files, data=data)
            if resp.status_code != 200:
                raise HTTPException(status_code=resp.status_code, detail=resp.text)
            return resp.json()
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Upload proxy error: {e}")


# ================= GARMIN TERRAIN & TOPOGRAPHY ELEVATION TILES =================

TERRARIUM_CACHE_DIR = Path("/app/data/terrarium_cache") if Path("/app").exists() else Path("data/terrarium_cache")
try:
    TERRARIUM_CACHE_DIR.mkdir(parents=True, exist_ok=True)
except Exception:
    pass


@app.get("/api/tiles/terrarium/{z}/{x}/{y}.png", summary="Terrarium Elevation Tiles Proxy")
async def get_terrarium_elevation_tile(z: int, x: int, y: int):
    """
    Proxies and caches Terrarium RGB elevation tiles from AWS Open Data (NASA SRTM elevation model).
    Formula: elevation_meters = (R * 256.0 + G + B / 256.0) - 32768.0.
    Cached on disk and served with immutable browser caching to eliminate CORS issues and maximize performance.
    """
    if z < 0 or z > 16 or x < 0 or y < 0:
        raise HTTPException(status_code=400, detail="Invalid tile coordinates")

    tile_path = TERRARIUM_CACHE_DIR / f"{z}_{x}_{y}.png"
    if tile_path.exists():
        return FileResponse(
            str(tile_path),
            media_type="image/png",
            headers={"Cache-Control": "public, max-age=604800, immutable"},
        )

    upstream_url = f"https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
    try:
        async with httpx.AsyncClient(timeout=8.0, headers={"User-Agent": "AT-F3001C-Sim/1.0"}) as client:
            resp = await client.get(upstream_url)
            if resp.status_code == 200:
                try:
                    tile_path.write_bytes(resp.content)
                except Exception as write_err:
                    logger.warning("Failed to cache elevation tile: %s", write_err)
                return Response(
                    content=resp.content,
                    media_type="image/png",
                    headers={"Cache-Control": "public, max-age=604800, immutable"},
                )
            else:
                raise HTTPException(status_code=resp.status_code, detail="Tile not found on elevation server")
    except HTTPException:
        raise
    except Exception as e:
        logger.warning("Terrarium tile proxy fetch error: %s", e)
        raise HTTPException(status_code=502, detail=f"Failed to fetch elevation tile: {e}")


@app.websocket("/ws/telemetry")
async def websocket_telemetry_endpoint(websocket: WebSocket):
    """
    Primary real-time WebSocket channel.
    Streams unified avionics payloads at 20-30 Hz (<50ms latency).
    Supports client ping/pong for ultra-accurate roundtrip latency monitoring.
    """
    await ws_manager.connect(websocket)
    try:
        while True:
            text = await websocket.receive_text()
            await ws_manager.handle_client_message(websocket, text)
    except WebSocketDisconnect:
        ws_manager.disconnect(websocket)
    except Exception as e:
        logger.debug("WebSocket client exception: %s", e)
        ws_manager.disconnect(websocket)


# Mount static instructor-panel files
static_dir = settings.resolve_static_dir()
if static_dir.exists():
    logger.info("Mounting Instructor Panel static directory from: %s", static_dir)
    app.mount("/", StaticFiles(directory=str(static_dir), html=True), name="instructor-panel")
else:
    logger.warning("Static directory not found at: %s. Creating empty placeholder.", static_dir)
    static_dir.mkdir(parents=True, exist_ok=True)
    app.mount("/", StaticFiles(directory=str(static_dir), html=True), name="instructor-panel")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "src.main:app",
        host=settings.HOST,
        port=settings.PORT,
        reload=False,
        log_level="info",
    )
