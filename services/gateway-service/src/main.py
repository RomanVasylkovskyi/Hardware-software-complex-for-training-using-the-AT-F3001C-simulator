"""
FastAPI Gateway Aggregator Application.
Unites telemetry-service, vision-service, and analytics-service.
Mounts and serves the Instructor Panel avionics web interface.
"""

import logging
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Dict

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
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
