"""
FastAPI Vision Service for AT-F3001C Flight Simulator.
Exposes REST and WebSocket endpoints for runway alignment detection.
Port: 8002.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import sys
import time
from typing import Any, Dict, Optional

# Ensure service directory is on sys.path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import uvicorn
from fastapi import FastAPI, File, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from detector import RunwayVisionDetector

logger = logging.getLogger("vision_service")
logging.basicConfig(level=logging.INFO)

app = FastAPI(
    title="AT-F3001C Vision Alignment Service",
    description="Real-time Computer Vision service for runway detection and approach alignment monitoring",
    version="1.0.0",
)

# CORS middleware for cross-origin access from instructor panels and tablet displays
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Instantiate detector
detector = RunwayVisionDetector(
    model_path=os.getenv("VISION_MODEL_PATH"),
    hfov_deg=float(os.getenv("CAMERA_HFOV_DEG", 60.0)),
)


class StreamConfigRequest(BaseModel):
    source: str = Field(..., description="RTSP URL, video file path, or camera device index")
    hfov_deg: Optional[float] = Field(None, description="Camera horizontal field of view in degrees")


class Base64ImageRequest(BaseModel):
    image_base64: str = Field(..., description="Base64 encoded JPEG or PNG image")
    hfov_deg: Optional[float] = Field(None, description="Camera horizontal FOV override")


@app.get("/health")
@app.get("/vision/status")
async def get_status() -> Dict[str, Any]:
    """Returns current operational status and hardware configuration."""
    return {
        "status": "ONLINE",
        "service": "vision-service",
        "port": 8002,
        "camera_hfov_deg": detector.hfov_deg,
        "active_stream_source": str(detector.current_source) if detector.current_source is not None else None,
        "stream_connected": detector.cap is not None and detector.cap.isOpened(),
        "yolo_model_loaded": detector.model_loaded,
        "timestamp": time.time(),
    }


@app.post("/vision/stream/configure")
async def configure_stream(config: StreamConfigRequest) -> Dict[str, Any]:
    """Configure or switch the active RTSP or video stream source."""
    if config.hfov_deg is not None and config.hfov_deg > 0:
        detector.hfov_deg = config.hfov_deg

    success = detector.open_stream(config.source)
    if not success:
        raise HTTPException(
            status_code=400,
            detail=f"Unable to open video stream source: {config.source}",
        )
    return {
        "status": "STREAM_CONFIGURED",
        "source": config.source,
        "hfov_deg": detector.hfov_deg,
    }


@app.post("/vision/alignment")
async def evaluate_alignment(
    file: Optional[UploadFile] = File(None),
    body: Optional[Base64ImageRequest] = None,
) -> Dict[str, Any]:
    """
    Evaluate runway alignment from:
    1. Uploaded image file (multipart/form-data)
    2. Base64 payload in JSON
    3. Active video capture stream if no image is uploaded
    """
    # 1. Process uploaded file
    if file is not None:
        try:
            content = await file.read()
            return detector.detect_from_bytes(content)
        except Exception as e:
            logger.error("Failed to process uploaded file: %s", e)
            return {
                "status": "ERROR_NO_FRAME",
                "error_message": f"Failed to read image file: {str(e)}",
                "lateral_offset_px": None,
                "angular_offset_deg": None,
            }

    # 2. Process Base64 payload
    if body is not None and body.image_base64:
        try:
            img_data = body.image_base64
            if "," in img_data:
                img_data = img_data.split(",", 1)[1]
            raw_bytes = base64.b64decode(img_data)
            if body.hfov_deg is not None:
                detector.hfov_deg = body.hfov_deg
            return detector.detect_from_bytes(raw_bytes)
        except Exception as e:
            logger.error("Failed to decode base64 image: %s", e)
            return {
                "status": "ERROR_NO_FRAME",
                "error_message": f"Invalid base64 encoding: {str(e)}",
                "lateral_offset_px": None,
                "angular_offset_deg": None,
            }

    # 3. Fallback: Read from active stream
    if detector.cap is not None and detector.cap.isOpened():
        return detector.detect_stream_frame()

    # 4. Neither image nor stream available
    return {
        "status": "ERROR_NO_FRAME",
        "error_message": "No image provided and no active video stream is connected",
        "lateral_offset_px": None,
        "angular_offset_deg": None,
    }


@app.websocket("/ws/vision")
async def websocket_vision_endpoint(websocket: WebSocket) -> None:
    """
    Real-time WebSocket endpoint for vision alignment.
    Clients can:
    - Receive continuous stream analysis if a stream source is open
    - Send base64 or binary image frames and receive instantaneous alignment results
    """
    await websocket.accept()
    logger.info("WebSocket client connected to /ws/vision")

    try:
        while True:
            # Check for incoming client messages with a short timeout
            try:
                message = await asyncio.wait_for(websocket.receive(), timeout=0.04)
                if "text" in message:
                    payload = json.loads(message["text"])
                    if "image_base64" in payload:
                        raw = base64.b64decode(payload["image_base64"].split(",")[-1])
                        result = detector.detect_from_bytes(raw)
                        await websocket.send_text(json.dumps(result))
                    elif "command" in payload and payload["command"] == "ping":
                        await websocket.send_text(json.dumps({"type": "pong", "time": time.time()}))
                elif "bytes" in message:
                    result = detector.detect_from_bytes(message["bytes"])
                    await websocket.send_text(json.dumps(result))
            except asyncio.TimeoutError:
                # If stream is active, grab next frame and broadcast
                if detector.cap is not None and detector.cap.isOpened():
                    detection = detector.detect_stream_frame()
                    await websocket.send_text(json.dumps({
                        "type": "stream_frame",
                        "timestamp": time.time(),
                        "detection": detection,
                    }))
                else:
                    await asyncio.sleep(0.02)
    except WebSocketDisconnect:
        logger.info("WebSocket client disconnected from /ws/vision")
    except Exception as e:
        logger.error("WebSocket error: %s", e)


if __name__ == "__main__":
    uvicorn.run("server:app", host="0.0.0.0", port=8002, reload=False)
