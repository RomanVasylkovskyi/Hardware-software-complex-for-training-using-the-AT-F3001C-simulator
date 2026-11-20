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
from pathlib import Path
from typing import Any, Dict, List, Optional, Set
from fastapi import FastAPI, File, Form, HTTPException, UploadFile, WebSocket, WebSocketDisconnect, status
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
        # CRITICAL: If Replay mode is active, live UDP packets MUST be ignored.
        # This prevents packet collision and violent gauge flickering between simulator and replay file.
        if self.parser.replay_mode or (replayer and replayer.is_running):
            return

        snapshot, err = self.parser.process_packet(data)
        if err:
            logger.warning("UDP packet parse error from %s: %s", addr, err)
        else:
            packet_event.set()

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
telemetry_parser.airport_icao = settings.airport_icao
ws_manager = WebSocketManager()
# Set on every successfully parsed packet so the broadcast loop pushes it immediately
# instead of waiting for the next polling tick (keeps end-to-end latency low).
packet_event = asyncio.Event()
replayer: Optional[FlightDataReplayer] = None

# Fields that are never needed by downstream consumers; excluded from the WebSocket stream.
WS_EXCLUDE_FIELDS = {"raw_channels"}

MAX_UPLOAD_BYTES = 200 * 1024 * 1024
SERVICE_DIR = Path(__file__).resolve().parent
UPLOAD_DIR_CANDIDATES = (Path("/app/uploads"), Path("/tmp/uploads"))


def recording_search_dirs() -> List[tuple]:
    """Directories that may hold flight recordings: (path, source, description prefix)."""
    return [
        (Path("/app/data"), "server", "Сервер симулятора"),
        (Path("/app/uploads"), "uploaded", "Завантажено користувачем"),
        (Path("/tmp/uploads"), "uploaded", "Завантажено користувачем"),
        (SERVICE_DIR.parent.parent / "data", "server", "Дані комплексу"),
        (SERVICE_DIR / "data", "server", "Локальні дані"),
    ]


def resolve_recording(requested: str) -> Path:
    """
    Resolve a client-supplied recording name to a file inside the allowed recording
    directories. Only the file name is honoured, so "../../etc/passwd" cannot escape.
    """
    name = Path(requested).name
    if not name or Path(name).suffix.lower() not in (".csv", ".txt"):
        raise HTTPException(status_code=400, detail="Only .csv and .txt flight recordings are supported")
    for directory, _, _ in recording_search_dirs():
        candidate = directory / name
        if candidate.is_file():
            return candidate.resolve()
    raise HTTPException(status_code=404, detail=f"Flight recording '{name}' not found")


def ingest_replay_packet(packet: bytes) -> None:
    """Direct replay path: parse the datagram and wake the broadcast loop."""
    _, err = telemetry_parser.process_packet(packet)
    if err:
        logger.warning("Replay packet rejected by parser: %s", err)
        return
    packet_event.set()


def snapshot_for_stream() -> dict:
    return telemetry_parser.check_staleness().model_dump(mode="json", exclude=WS_EXCLUDE_FIELDS)
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
                telemetry_parser.replay_progress_pct = None

            telemetry_parser.check_staleness()
            await asyncio.sleep(0.1)  # 10 Hz check
    except asyncio.CancelledError:
        logger.info("Telemetry watchdog loop stopped.")


async def broadcast_loop() -> None:
    """
    WebSocket broadcast loop.
    Pushes a snapshot as soon as a packet arrives (rate-capped at ws_broadcast_rate_hz) and
    sends a heartbeat snapshot at least every heartbeat interval, so staleness/offline
    transitions still reach clients when the simulator stops sending.
    """
    min_interval = 1.0 / max(1.0, settings.ws_broadcast_rate_hz)
    heartbeat = max(min_interval, settings.ws_heartbeat_interval_sec)
    logger.info(
        "Telemetry WebSocket broadcast loop started (max %.0f Hz, heartbeat %.2fs).",
        settings.ws_broadcast_rate_hz, heartbeat,
    )
    loop = asyncio.get_running_loop()
    last_sent = 0.0
    try:
        while True:
            try:
                await asyncio.wait_for(packet_event.wait(), timeout=heartbeat)
            except asyncio.TimeoutError:
                pass
            packet_event.clear()

            wait = min_interval - (loop.time() - last_sent)
            if wait > 0:
                await asyncio.sleep(wait)

            await ws_manager.broadcast_json(snapshot_for_stream())
            last_sent = loop.time()
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
                direct_callback=ingest_replay_packet
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


@app.get("/replay/status", tags=["Replay"])
async def get_replay_status() -> dict:
    """Get active replay engine status and progress."""
    global replayer
    is_running = bool(replayer and replayer.is_running)
    file_name = Path(replayer.file_path_str).name if (replayer and replayer.file_path_str) else None
    snapshot = telemetry_parser.check_staleness()

    return {
        "mode": "replay" if telemetry_parser.replay_mode else "live",
        "is_running": is_running,
        "file_name": file_name,
        "file_path": replayer.file_path_str if replayer else None,
        "current_index": replayer.current_index if replayer else 0,
        "total_records": replayer.total_records if replayer else 0,
        "progress_pct": replayer.progress_pct if replayer else 0.0,
        "speed": replayer.speed_multiplier if replayer else 1.0,
        "loop": replayer.loop if replayer else True,
        "packets_received": snapshot.status.packets_received,
        "packet_rate_hz": snapshot.status.packet_rate_hz,
        "connection": snapshot.status.connection.value if hasattr(snapshot.status.connection, "value") else str(snapshot.status.connection),
    }


@app.get("/replay/files", tags=["Replay"])
async def list_replay_files() -> dict:
    """List available authentic flight recordings stored on server."""
    files_list = []
    seen_names = set()

    for search_dir, source, desc_prefix in recording_search_dirs():
        if not search_dir.is_dir():
            continue
        try:
            for p in sorted(search_dir.iterdir(), key=lambda x: x.name):
                if p.is_file() and p.suffix.lower() in (".csv", ".txt") and p.name not in seen_names:
                    seen_names.add(p.name)
                    size_b = p.stat().st_size
                    if size_b >= 1024 * 1024:
                        size_str = f"{size_b / (1024 * 1024):.1f} MB"
                    else:
                        size_str = f"{max(1, round(size_b / 1024))} KB"

                    desc = f"{desc_prefix}: {p.name} ({size_str})"
                    if p.name == "telemetry_essential.csv":
                        desc = f"Базовий тренувальний політ Cessna 172SP (UKLL RWY 13, {size_str})"
                    elif p.name == "Data.txt":
                        desc = f"Повний первинний лог польоту X-Plane 11 Data.txt ({size_str})"

                    files_list.append({
                        "filename": p.name,
                        "path": str(p),
                        "size_bytes": size_b,
                        "size_formatted": size_str,
                        "type": p.suffix.lower().replace(".", ""),
                        "source": source,
                        "description": desc,
                    })
        except Exception as e:
            logger.warning(f"Error scanning {search_dir}: {e}")

    return {"files": files_list}


@app.post("/replay/start", tags=["Replay"])
async def start_replay(req: Optional[ReplayControlRequest] = None) -> dict:
    """
    Start recorded authentic flight data replay.
    Never uses fake data; loads verified flight recordings.
    """
    global replayer
    req_file = str(resolve_recording(req.file_path)) if (req and req.file_path) else None
    speed = req.speed if (req and req.speed) else 1.0
    loop = req.loop if (req and req.loop is not None) else True

    # Stop any active replay first to ensure clean state and avoid overlapping replays
    if replayer and replayer.is_running:
        replayer.stop()
        replayer = None

    replayer = FlightDataReplayer(
        file_path=req_file or settings.replay_file_path,
        target_host="127.0.0.1",
        target_port=settings.udp_port,
        speed_multiplier=speed,
        loop=loop,
    )

    try:
        telemetry_parser.replay_mode = True
        telemetry_parser.reset()
        await replayer.start(
            direct_callback=ingest_replay_packet
        )
        return {
            "status": "started",
            "file_name": Path(replayer.file_path_str or "").name,
            "total_records": replayer.total_records,
            "speed": replayer.speed_multiplier,
            "loop": replayer.loop,
        }
    except Exception as e:
        logger.error(f"Failed to start replay: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/replay/stop", tags=["Replay"])
async def stop_replay() -> dict:
    """Stop active flight data replay and switch back to live X-Plane UDP ingestion."""
    global replayer
    if replayer and replayer.is_running:
        replayer.stop()
        replayer = None
    telemetry_parser.replay_mode = False
    telemetry_parser.reset()
    return {"status": "stopped", "mode": "idle"}


@app.post("/telemetry/mode/live", tags=["Telemetry"])
async def switch_to_live_mode() -> dict:
    """Stop any active replay and switch directly to live X-Plane UDP ingestion."""
    global replayer
    if replayer and replayer.is_running:
        replayer.stop()
        replayer = None
    telemetry_parser.replay_mode = False
    telemetry_parser.reset()
    return {
        "status": "live_mode_active",
        "message": "Switched to live X-Plane 11 UDP mode",
        "udp_host": settings.udp_host,
        "udp_port": settings.udp_port,
    }


@app.post("/replay/upload", tags=["Replay"])
async def upload_flight_file(
    file: UploadFile = File(...),
    start_immediately: bool = Form(True),
    speed: float = Form(1.0),
    loop: bool = Form(True),
) -> dict:
    """
    Upload a flight recording from user's PC (.csv or .txt) and optionally start replay immediately.
    """
    global replayer
    if not file.filename:
        raise HTTPException(status_code=400, detail="Filename missing")

    ext = Path(file.filename).suffix.lower()
    if ext not in (".csv", ".txt"):
        raise HTTPException(status_code=400, detail="Only .csv and .txt flight recordings are supported")

    upload_dir: Optional[Path] = None
    for candidate in UPLOAD_DIR_CANDIDATES:
        try:
            candidate.mkdir(parents=True, exist_ok=True)
            upload_dir = candidate
            break
        except OSError as e:
            logger.warning("Upload directory %s unavailable: %s", candidate, e)
    if upload_dir is None:
        raise HTTPException(status_code=500, detail="No writable upload directory")

    safe_name = Path("".join(c for c in Path(file.filename).name if c.isalnum() or c in "._- ")).name
    if not safe_name or safe_name.startswith("."):
        raise HTTPException(status_code=400, detail="Invalid file name")
    dest_path = upload_dir / safe_name
    tmp_path = upload_dir / f".{safe_name}.part"

    size_b = 0
    try:
        with open(tmp_path, "wb") as out:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                size_b += len(chunk)
                if size_b > MAX_UPLOAD_BYTES:
                    raise HTTPException(
                        status_code=413,
                        detail=f"File exceeds {MAX_UPLOAD_BYTES // (1024 * 1024)} MB limit",
                    )
                out.write(chunk)
        if size_b == 0:
            raise HTTPException(status_code=400, detail="Uploaded file is empty")
        tmp_path.replace(dest_path)
    finally:
        if tmp_path.exists():
            tmp_path.unlink()
    logger.info("Uploaded flight recording saved to %s (%d bytes)", dest_path, size_b)

    size_str = f"{size_b / (1024 * 1024):.1f} MB" if size_b >= 1024 * 1024 else f"{max(1, round(size_b / 1024))} KB"

    result = {
        "status": "uploaded",
        "file_name": safe_name,
        "file_path": str(dest_path),
        "size_bytes": size_b,
        "size_formatted": size_str,
    }

    if start_immediately:
        if replayer and replayer.is_running:
            replayer.stop()
            replayer = None

        replayer = FlightDataReplayer(
            file_path=str(dest_path),
            target_host="127.0.0.1",
            target_port=settings.udp_port,
            speed_multiplier=speed,
            loop=loop,
        )

        try:
            telemetry_parser.replay_mode = True
            telemetry_parser.reset()
            await replayer.start(
                direct_callback=ingest_replay_packet
            )
            result["replay_started"] = True
            result["total_records"] = replayer.total_records
            result["speed"] = replayer.speed_multiplier
            result["loop"] = replayer.loop
        except Exception as e:
            logger.error(f"Failed to start replay for uploaded file: {e}")
            result["replay_started"] = False
            result["error"] = str(e)

    return result


@app.websocket("/ws/telemetry")
async def websocket_telemetry_endpoint(websocket: WebSocket) -> None:
    """
    Real-time WebSocket streaming endpoint for Gateway, PFD, ND, Engine, and Copilot.
    Streams telemetry snapshots as JSON messages.
    """
    await ws_manager.connect(websocket)
    try:
        # Send immediate initial snapshot
        await websocket.send_json(snapshot_for_stream())

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
