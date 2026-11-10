"""
FastAPI / AsyncIO Telemetry Microservice for AT-F3001C Hardware-Software Complex.

Responsibilities:
- Runs high-throughput asyncio UDP listener on 0.0.0.0:49000 receiving X-Plane 11 binary packets.
- Parses packets in real-time, enforcing zero fake/stub data.
- Provides REST endpoint /telemetry/current and WebSocket /ws/telemetry for real-time delivery to the Gateway.
- Tracks packet rates, packet drops, channel staleness, and simulator offline status.
- Integrates authentic flight data replay engine.
"""

import asyncio
from contextlib import asynccontextmanager
from datetime import datetime, timezone
import json
import logging
from typing import List, Optional, Set
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

try:
    from .config import settings
    from .models import (
        ConnectionStatus,
        HealthResponse,
        ReplayControlRequest,
        SimulatorStatus,
        TelemetrySnapshot,
    )
    from .parser import TelemetryParser
    from .replay import FlightDataReplayer
except ImportError:
    from config import settings
    from models import (
        ConnectionStatus,
        HealthResponse,
        ReplayControlRequest,
        SimulatorStatus,
        TelemetrySnapshot,
    )
    from parser import TelemetryParser
    from replay import FlightDataReplayer

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] [telemetry-service] %(message)s",
)
logger = logging.getLogger("telemetry-service")


class WebSocketManager:
    """Manages active WebSocket client connections and broadcasting."""

    def __init__(self):
        self._active_connections: Set[WebSocket] = set()
        self._lock = asyncio.Lock()

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        async with self._lock:
            self._active_connections.add(websocket)
        logger.info(f"WebSocket client connected. Active clients: {len(self._active_connections)}")

    async def disconnect(self, websocket: WebSocket) -> None:
        async with self._lock:
            self._active_connections.discard(websocket)
        logger.info(f"WebSocket client disconnected. Active clients: {len(self._active_connections)}")

    async def broadcast_json(self, data: dict) -> None:
        """Broadcast payload to all connected clients, pruning dead sockets."""
        async with self._lock:
            clients = list(self._active_connections)

        if not clients:
            return

        dead_clients: List[WebSocket] = []
        for ws in clients:
            try:
                await ws.send_json(data)
            except Exception:
                dead_clients.append(ws)

        if dead_clients:
            async with self._lock:
                for dead in dead_clients:
                    self._active_connections.discard(dead)


class TelemetryUDPProtocol(asyncio.DatagramProtocol):
    """AsyncIO DatagramProtocol to receive X-Plane 11 UDP packets."""

    def __init__(self, parser: TelemetryParser):
        self.parser = parser
        self.transport: Optional[asyncio.DatagramTransport] = None

    def connection_made(self, transport: asyncio.BaseTransport) -> None:
        self.transport = transport  # type: ignore
        sockname = self.transport.get_extra_info("sockname") if self.transport else None
        logger.info(f"UDP listener successfully bound on {sockname}")

    def datagram_received(self, data: bytes, addr: tuple) -> None:
        """Invoked immediately on every incoming UDP datagram."""
        snapshot, err = self.parser.process_packet(data)
        if err:
            logger.warning(f"UDP packet parse error from {addr}: {err}")

    def error_received(self, exc: Exception) -> None:
        logger.error(f"UDP socket error received: {exc}")

    def connection_lost(self, exc: Optional[Exception]) -> None:
        if exc:
            logger.error(f"UDP transport closed with error: {exc}")
        else:
            logger.info("UDP transport cleanly closed.")


# Service state singletons
telemetry_parser = TelemetryParser(
    stale_timeout_sec=settings.channel_stale_timeout_sec,
    offline_timeout_sec=settings.simulator_offline_timeout_sec,
    expected_interval_sec=settings.expected_packet_interval_sec,
)
ws_manager = WebSocketManager()
replayer: Optional[FlightDataReplayer] = None
udp_transport: Optional[asyncio.DatagramTransport] = None
watchdog_task: Optional[asyncio.Task] = None
broadcast_task: Optional[asyncio.Task] = None


async def watchdog_loop() -> None:
    """
    Periodic watchdog:
    - Evaluates staleness of channels and overall simulator connection.
    - Updates replay progress if active.
    """
    logger.info("Telemetry watchdog loop started.")
    try:
        while True:
            if replayer and replayer.is_running:
                telemetry_parser.replay_mode = True
                telemetry_parser.replay_progress_pct = replayer.progress_pct
            else:
                telemetry_parser.replay_mode = settings.replay_mode

            telemetry_parser.check_staleness()
            await asyncio.sleep(0.1)  # 10 Hz check
    except asyncio.CancelledError:
        logger.info("Telemetry watchdog loop stopped.")


async def broadcast_loop() -> None:
    """
    Periodic WebSocket broadcast loop.
    Ensures connected clients receive live telemetry stream at steady rate.
    """
    logger.info(f"Telemetry WebSocket broadcast loop started at {settings.ws_broadcast_rate_hz} Hz.")
    interval = 1.0 / max(1.0, settings.ws_broadcast_rate_hz)
    try:
        while True:
            snapshot = telemetry_parser.check_staleness()
            snapshot_dict = snapshot.model_dump(mode="json")
            await ws_manager.broadcast_json(snapshot_dict)
            await asyncio.sleep(interval)
    except asyncio.CancelledError:
        logger.info("Telemetry WebSocket broadcast loop stopped.")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan manager for startup and graceful shutdown."""
    global udp_transport, watchdog_task, broadcast_task, replayer

    logger.info("Initializing Telemetry Service...")
    loop = asyncio.get_running_loop()

    # 1. Bind UDP Listener on 0.0.0.0:49000
    try:
        transport, _ = await loop.create_datagram_endpoint(
            lambda: TelemetryUDPProtocol(telemetry_parser),
            local_addr=(settings.udp_host, settings.udp_port),
        )
        udp_transport = transport
        logger.info(f"X-Plane UDP listener active on {settings.udp_host}:{settings.udp_port}")
    except OSError as e:
        logger.error(
            f"Failed to bind UDP socket on {settings.udp_host}:{settings.udp_port}: {e}. "
            "Another simulator listener might be running."
        )

    # 2. Start background watchdog & broadcast loops
    watchdog_task = asyncio.create_task(watchdog_loop())
    broadcast_task = asyncio.create_task(broadcast_loop())

    # 3. Initialize Replay Engine if configured
    replayer = FlightDataReplayer(
        file_path=settings.replay_file_path,
        target_host="127.0.0.1",
        target_port=settings.udp_port,
        speed_multiplier=settings.replay_speed,
        loop=settings.replay_loop,
    )

    if settings.replay_mode:
        logger.info("REPLAY_MODE is enabled in configuration. Starting flight replay...")
        telemetry_parser.replay_mode = True
        try:
            # We pass direct callback to avoid loopback socket restrictions in isolated environments
            await replayer.start(
                direct_callback=lambda pkt: telemetry_parser.process_packet(pkt)
            )
        except Exception as e:
            logger.error(f"Failed to start automatic replay: {e}")

    yield

    # Shutdown
    logger.info("Shutting down Telemetry Service...")
    if replayer and replayer.is_running:
        replayer.stop()

    if watchdog_task and not watchdog_task.done():
        watchdog_task.cancel()

    if broadcast_task and not broadcast_task.done():
        broadcast_task.cancel()

    if udp_transport:
        udp_transport.close()

    logger.info("Telemetry Service shutdown complete.")


# Initialize FastAPI app
app = FastAPI(
    title="AT-F3001C Telemetry Service",
    description="Real-time X-Plane 11 UDP telemetry ingestion, binary parsing, and streaming service.",
    version="1.0.0",
    lifespan=lifespan,
)

# Enable CORS for gateway and web frontend tablets
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health", response_model=HealthResponse, tags=["Health"])
async def get_health() -> HealthResponse:
    """Service health probe and simulator connection status."""
    snapshot = telemetry_parser.check_staleness()
    return HealthResponse(
        service=settings.service_name,
        status="ok",
        simulator_connection=snapshot.status.connection,
        packets_received=snapshot.status.packets_received,
        packet_rate_hz=snapshot.status.packet_rate_hz,
        replay_mode=telemetry_parser.replay_mode,
        timestamp=datetime.now(timezone.utc),
    )


@app.get("/telemetry/current", response_model=TelemetrySnapshot, tags=["Telemetry"])
async def get_current_telemetry() -> TelemetrySnapshot:
    """
    Get the latest real-time aircraft telemetry snapshot.
    Strictly reports null for unreceived/missing metrics and flags error status.
    """
    snapshot = telemetry_parser.check_staleness()
    return snapshot


@app.get("/telemetry/status", response_model=SimulatorStatus, tags=["Telemetry"])
async def get_simulator_status() -> SimulatorStatus:
    """
    Get simulator network connection metrics, packet reception rate,
    packet drop counter, and per-channel freshness.
    """
    snapshot = telemetry_parser.check_staleness()
    return snapshot.status


@app.post("/replay/start", tags=["Replay"])
async def start_replay(req: Optional[ReplayControlRequest] = None) -> dict:
    """
    Start recorded authentic flight data replay.
    Never uses fake data; loads verified flight recordings.
    """
    global replayer
    if replayer is None:
        replayer = FlightDataReplayer(
            file_path=req.file_path if req and req.file_path else settings.replay_file_path,
            target_host="127.0.0.1",
            target_port=settings.udp_port,
            speed_multiplier=req.speed if req and req.speed else settings.replay_speed,
            loop=req.loop if req and req.loop is not None else settings.replay_loop,
        )

    if req:
        if req.speed is not None:
            replayer.set_speed(req.speed)
        if req.loop is not None:
            replayer.loop = req.loop

    if replayer.is_running:
        return {"status": "already_running", "progress_pct": replayer.progress_pct}

    try:
        telemetry_parser.replay_mode = True
        await replayer.start(
            direct_callback=lambda pkt: telemetry_parser.process_packet(pkt)
        )
        return {
            "status": "started",
            "total_records": replayer.total_records,
            "speed": replayer.speed_multiplier,
            "loop": replayer.loop,
        }
    except Exception as e:
        logger.error(f"Failed to start replay: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/replay/stop", tags=["Replay"])
async def stop_replay() -> dict:
    """Stop active flight data replay."""
    if replayer and replayer.is_running:
        replayer.stop()
        telemetry_parser.replay_mode = False
        return {"status": "stopped"}
    return {"status": "not_running"}


@app.websocket("/ws/telemetry")
async def websocket_telemetry_endpoint(websocket: WebSocket) -> None:
    """
    Real-time WebSocket streaming endpoint for Gateway, PFD, ND, Engine, and Copilot.
    Streams telemetry snapshots as JSON messages.
    """
    await ws_manager.connect(websocket)
    try:
        # Send immediate initial snapshot
        initial_snapshot = telemetry_parser.check_staleness()
        await websocket.send_json(initial_snapshot.model_dump(mode="json"))

        # Keep receiving client heartbeats / control pings
        while True:
            text = await websocket.receive_text()
            try:
                cmd = json.loads(text)
                if cmd.get("action") == "ping":
                    await websocket.send_json({"action": "pong", "timestamp": datetime.now(timezone.utc).isoformat()})
                elif cmd.get("action") == "get_status":
                    status = telemetry_parser.check_staleness().status
                    await websocket.send_json({"action": "status", "data": status.model_dump(mode="json")})
            except json.JSONDecodeError:
                pass
    except WebSocketDisconnect:
        await ws_manager.disconnect(websocket)
    except Exception as e:
        logger.debug(f"WebSocket client loop terminated: {e}")
        await ws_manager.disconnect(websocket)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "server:app",
        host=settings.http_host,
        port=settings.http_port,
        reload=settings.debug,
        log_level="info",
    )
