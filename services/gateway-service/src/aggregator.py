"""
Stream Aggregator.
Subscribes to upstream microservices (telemetry, analytics),
coordinates real-time forwarding between telemetry and analytics,
and merges them into a unified, high-frequency avionics payload.
"""

import asyncio
import json
import logging
import time
from datetime import datetime, timezone
from typing import Any, Dict, Optional

import websockets

try:
    from .config import Settings
except ImportError:
    from config import Settings

logger = logging.getLogger("gateway.aggregator")


def normalize_telemetry(raw: Any) -> Optional[Dict[str, Any]]:
    """
    Ensure telemetry payload provides both flat avionics fields
    and nested subsystem objects for maximum compatibility.
    Strictly preserves nulls (never fakes data).
    """
    if not isinstance(raw, dict):
        return None

    # Check if this is an envelope like {"telemetry": {...}}
    if "telemetry" in raw and isinstance(raw["telemetry"], dict) and "speeds" not in raw:
        raw = raw["telemetry"]

    flat = dict(raw)

    # 1. Speeds
    if "speeds" in raw and isinstance(raw["speeds"], dict):
        for k, v in raw["speeds"].items():
            if k not in flat or flat[k] is None:
                flat[k] = v

    # 2. Attitude
    if "attitude" in raw and isinstance(raw["attitude"], dict):
        for k, v in raw["attitude"].items():
            if k not in flat or flat[k] is None:
                flat[k] = v

    # 3. Position
    if "position" in raw and isinstance(raw["position"], dict):
        for k, v in raw["position"].items():
            if k not in flat or flat[k] is None:
                flat[k] = v

    # 4. Dynamics
    if "dynamics" in raw and isinstance(raw["dynamics"], dict):
        for k, v in raw["dynamics"].items():
            if k not in flat or flat[k] is None:
                flat[k] = v

    # 5. Controls
    if "controls" in raw and isinstance(raw["controls"], dict):
        for k, v in raw["controls"].items():
            if k not in flat or flat[k] is None:
                flat[k] = v
        if "elevator" in raw["controls"] and "elevator_stick" not in flat:
            flat["elevator_stick"] = raw["controls"]["elevator"]

    # 6. Engine
    if "engine" in raw and isinstance(raw["engine"], dict):
        for k, v in raw["engine"].items():
            if k not in flat or flat[k] is None:
                flat[k] = v
        if "rpm" in raw["engine"] and ("engine_rpm" not in flat or flat["engine_rpm"] is None):
            flat["engine_rpm"] = raw["engine"]["rpm"]
        if "oil_temp_degc" in raw["engine"] and ("oil_temp_c" not in flat or flat["oil_temp_c"] is None):
            flat["oil_temp_c"] = raw["engine"]["oil_temp_degc"]
        if "oil_pressure_psi" in raw["engine"] and ("oil_press_psi" not in flat or flat["oil_press_psi"] is None):
            flat["oil_press_psi"] = raw["engine"]["oil_pressure_psi"]
        if "egt_degc" in raw["engine"] and ("egt_c" not in flat or flat["egt_c"] is None):
            flat["egt_c"] = raw["engine"]["egt_degc"]
        if "fuel_flow_gph" in raw["engine"] and ("fuel_flow_gph" not in flat or flat["fuel_flow_gph"] is None):
            flat["fuel_flow_gph"] = raw["engine"]["fuel_flow_gph"]
        if "fuel_quantity_gal" in raw["engine"] and ("fuel_qty_gal" not in flat or flat["fuel_qty_gal"] is None):
            flat["fuel_qty_gal"] = raw["engine"]["fuel_quantity_gal"]
        if "fuel_flow_pph" in raw["engine"] and ("fuel_flow_gph" not in flat or flat["fuel_flow_gph"] is None) and raw["engine"]["fuel_flow_pph"] is not None:
            flat["fuel_flow_gph"] = round(raw["engine"]["fuel_flow_pph"] / 6.0, 1)

    # 7. Flight Times
    if "flight_times" in raw and isinstance(raw["flight_times"], dict):
        for k, v in raw["flight_times"].items():
            if k not in flat or flat[k] is None:
                flat[k] = v
        if "total_time_sec" in raw["flight_times"] and "time_sec" not in flat:
            flat["time_sec"] = raw["flight_times"]["total_time_sec"]

    # 8. Autopilot & Flight Director
    if "autopilot" in raw and isinstance(raw["autopilot"], dict):
        for k, v in raw["autopilot"].items():
            if k not in flat or flat[k] is None:
                flat[k] = v

    # Raw X-Plane channel arrays are diagnostic only; no client reads them and they
    # roughly double every message sent to the panels.
    flat.pop("raw_channels", None)

    return flat


def analytics_frame(normalized: Dict[str, Any]) -> Dict[str, Any]:
    """Flat scalar fields only: what the analytics service evaluates."""
    return {k: v for k, v in normalized.items() if not isinstance(v, (dict, list))}


class StreamAggregator:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.running = False

        # Status of each upstream microservice ("ONLINE" or "OFFLINE")
        self.service_status: Dict[str, str] = {
            "telemetry": "OFFLINE",
            "analytics": "OFFLINE",
        }

        # Latest raw payload from each upstream service (None if OFFLINE)
        self.latest_data: Dict[str, Optional[Dict[str, Any]]] = {
            "telemetry": None,
            "analytics": None,
        }

        # Telemetry frames waiting to be piped to the analytics service. Analytics is
        # stateful (flight phase, touchdown window), so frames are queued in order rather
        # than "latest only"; the bound keeps memory flat if analytics stalls.
        self._analytics_queue: asyncio.Queue = asyncio.Queue(maxsize=settings.ANALYTICS_QUEUE_SIZE)
        self._analytics_dropped = 0
        # Analytics only answers frames it is sent, so silence is not a failure by itself:
        # it is OFFLINE when disconnected, or when frames were sent but not answered in time.
        self._analytics_connected = False
        self._analytics_last_sent = 0.0

        # Set whenever fresh upstream data arrives; the broadcaster waits on it.
        self.update_event = asyncio.Event()

        # Last time a packet was received from each service (unix timestamp)
        self.last_seen: Dict[str, float] = {
            "telemetry": 0.0,
            "analytics": 0.0,
        }

        # Statistics
        self.packet_counts: Dict[str, int] = {
            "telemetry": 0,
            "analytics": 0,
        }

        self._tasks: list[asyncio.Task] = []

    async def start(self) -> None:
        """Start upstream listeners and watchdog timer."""
        if self.running:
            return
        self.running = True
        logger.info("Starting upstream stream aggregator...")

        # Spawn listeners for each upstream service
        self._tasks.append(
            asyncio.create_task(
                self._listen_telemetry(self.settings.TELEMETRY_WS_URL),
                name="listen_telemetry",
            )
        )
        self._tasks.append(
            asyncio.create_task(
                self._listen_analytics(self.settings.ANALYTICS_WS_URL),
                name="listen_analytics",
            )
        )

        # Spawn watchdog task
        self._tasks.append(
            asyncio.create_task(self._watchdog_loop(), name="aggregator_watchdog")
        )

    async def stop(self) -> None:
        """Stop all upstream listeners."""
        self.running = False
        logger.info("Stopping stream aggregator...")
        for task in self._tasks:
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        self._tasks.clear()

        # Mark all services offline
        for key in self.service_status:
            self.service_status[key] = "OFFLINE"
            self.latest_data[key] = None

    async def _listen_telemetry(self, ws_url: str) -> None:
        """Listen to telemetry-service on port 8001."""
        reconnect_delay = self.settings.RECONNECT_DELAY_SEC

        while self.running:
            try:
                logger.debug("Connecting to telemetry at %s...", ws_url)
                async with websockets.connect(
                    ws_url,
                    ping_interval=5,
                    ping_timeout=5,
                    close_timeout=3,
                ) as ws:
                    logger.info("Connected to upstream service [telemetry] at %s", ws_url)
                    self.service_status["telemetry"] = "ONLINE"
                    self.last_seen["telemetry"] = time.time()

                    async for message in ws:
                        if not self.running:
                            break
                        now = time.time()
                        self.last_seen["telemetry"] = now
                        self.service_status["telemetry"] = "ONLINE"
                        self.packet_counts["telemetry"] += 1

                        try:
                            if isinstance(message, bytes):
                                message = message.decode("utf-8")
                            raw_data = json.loads(message)
                        except (json.JSONDecodeError, UnicodeDecodeError) as parse_err:
                            logger.warning("Failed to parse telemetry JSON: %s", parse_err)
                            continue
                        normalized = normalize_telemetry(raw_data)
                        if normalized is None:
                            logger.warning("Ignoring non-object telemetry message")
                            continue
                        self.latest_data["telemetry"] = normalized
                        self.update_event.set()
                        if self._analytics_connected:
                            self._enqueue_for_analytics(analytics_frame(normalized))

            except (
                ConnectionRefusedError,
                OSError,
                websockets.exceptions.WebSocketException,
                asyncio.TimeoutError,
            ) as e:
                if self.service_status["telemetry"] != "OFFLINE":
                    logger.warning("Upstream [telemetry] unreachable (%s). Marking OFFLINE.", e)
                self.service_status["telemetry"] = "OFFLINE"
                self.latest_data["telemetry"] = None

            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error("Unexpected error in telemetry listener: %s", e)
                self.service_status["telemetry"] = "OFFLINE"
                self.latest_data["telemetry"] = None

            if self.running:
                await asyncio.sleep(reconnect_delay)

    def _enqueue_for_analytics(self, frame: Dict[str, Any]) -> None:
        try:
            self._analytics_queue.put_nowait(frame)
        except asyncio.QueueFull:
            # Drop the oldest frame: analytics is behind, keep the stream moving.
            try:
                self._analytics_queue.get_nowait()
            except asyncio.QueueEmpty:
                pass
            self._analytics_queue.put_nowait(frame)
            self._analytics_dropped += 1
            if self._analytics_dropped % 100 == 1:
                logger.warning(
                    "Analytics service is lagging: %d telemetry frames dropped so far",
                    self._analytics_dropped,
                )

    def _drain_analytics_queue(self) -> None:
        while not self._analytics_queue.empty():
            self._analytics_queue.get_nowait()

    async def _pipe_to_analytics(self, ws: Any) -> None:
        """Send queued telemetry frames to the analytics service in order."""
        while True:
            frame = await self._analytics_queue.get()
            await ws.send(json.dumps(frame))
            self._analytics_last_sent = time.time()

    async def _receive_from_analytics(self, ws: Any) -> None:
        async for message in ws:
            if not self.running:
                return
            self.last_seen["analytics"] = time.time()
            self.service_status["analytics"] = "ONLINE"
            self.packet_counts["analytics"] += 1
            try:
                if isinstance(message, bytes):
                    message = message.decode("utf-8")
                data = json.loads(message)
            except (json.JSONDecodeError, UnicodeDecodeError) as parse_err:
                logger.warning("Failed to parse analytics JSON: %s", parse_err)
                continue
            if isinstance(data, dict) and "error" in data:
                logger.warning("Analytics rejected a frame: %s", data["error"])
                continue
            self.latest_data["analytics"] = data
            self.update_event.set()

    async def _listen_analytics(self, ws_url: str) -> None:
        """Connect to analytics-service, pipe telemetry frames in and receive evaluations."""
        reconnect_delay = self.settings.RECONNECT_DELAY_SEC

        while self.running:
            try:
                logger.debug("Connecting to analytics at %s...", ws_url)
                async with websockets.connect(
                    ws_url,
                    ping_interval=5,
                    ping_timeout=5,
                    close_timeout=3,
                ) as ws:
                    logger.info("Connected to upstream service [analytics] at %s", ws_url)
                    # A new connection starts a new analytics flight state: send only fresh frames.
                    self._drain_analytics_queue()
                    self._analytics_connected = True
                    self.service_status["analytics"] = "ONLINE"
                    self.last_seen["analytics"] = time.time()

                    sender = asyncio.create_task(self._pipe_to_analytics(ws), name="analytics_sender")
                    receiver = asyncio.create_task(self._receive_from_analytics(ws), name="analytics_receiver")
                    try:
                        done, pending = await asyncio.wait(
                            {sender, receiver}, return_when=asyncio.FIRST_COMPLETED
                        )
                    finally:
                        self._analytics_connected = False
                        for task in (sender, receiver):
                            if not task.done():
                                task.cancel()
                        await asyncio.gather(sender, receiver, return_exceptions=True)
                    for task in done:
                        if not task.cancelled() and task.exception() is not None:
                            raise task.exception()

            except (
                ConnectionRefusedError,
                OSError,
                websockets.exceptions.WebSocketException,
                asyncio.TimeoutError,
            ) as e:
                if self.service_status["analytics"] != "OFFLINE":
                    logger.warning("Upstream [analytics] unreachable (%s). Marking OFFLINE.", e)
                self.service_status["analytics"] = "OFFLINE"
                self.latest_data["analytics"] = None

            except asyncio.CancelledError:
                break
            except Exception:
                logger.exception("Unexpected error in analytics stream")
                self.service_status["analytics"] = "OFFLINE"
                self.latest_data["analytics"] = None

            if self.running:
                await asyncio.sleep(reconnect_delay)

    async def _watchdog_loop(self) -> None:
        """
        Watchdog: if an upstream service hasn't sent data in HEARTBEAT_TIMEOUT_SEC,
        transition it to OFFLINE and null out its data.
        NEVER leave frozen or stale telemetry!
        """
        timeout = self.settings.HEARTBEAT_TIMEOUT_SEC
        while self.running:
            try:
                await asyncio.sleep(0.2)
                now = time.time()
                for name, last in list(self.last_seen.items()):
                    if name == "analytics" and self._analytics_connected:
                        # Connected but idle (nothing sent) is healthy; only unanswered frames count.
                        if not (self._analytics_last_sent - last > timeout):
                            continue
                    if self.service_status[name] == "ONLINE":
                        if (now - last) > timeout:
                            logger.warning(
                                "Service [%s] heartbeat timed out (%.2fs without packet). Setting to OFFLINE.",
                                name,
                                now - last,
                            )
                            self.service_status[name] = "OFFLINE"
                            self.latest_data[name] = None
                            self.update_event.set()
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error("Error in watchdog loop: %s", e)

    def get_unified_payload(self) -> Dict[str, Any]:
        """
        Build the unified payload.
        CRITICAL REQUIREMENT:
        If a service is OFFLINE, its data field MUST BE null (None).
        NEVER stub or fake missing data!
        """
        now = time.time()
        return {
            "type": "telemetry_snapshot",
            "timestamp": now,
            "server_time_iso": datetime.now(timezone.utc).isoformat(),
            "service_status": dict(self.service_status),
            "telemetry": (
                self.latest_data["telemetry"]
                if self.service_status["telemetry"] == "ONLINE"
                else None
            ),
            "analytics": (
                self.latest_data["analytics"]
                if self.service_status["analytics"] == "ONLINE"
                else None
            ),
            "airport_icao": self.settings.AIRPORT_ICAO,
            "runway_ident": self.settings.RUNWAY_IDENT,
            "broadcast_rate_hz": self.settings.BROADCAST_RATE_HZ,
        }

    def get_status_summary(self) -> Dict[str, Any]:
        """Detailed status overview for REST API diagnostics."""
        now = time.time()
        return {
            "status": "ok",
            "uptime_active": self.running,
            "service_status": dict(self.service_status),
            "packet_counts": dict(self.packet_counts),
            "last_seen_sec_ago": {
                name: (now - last if last > 0 else None)
                for name, last in self.last_seen.items()
            },
            "broadcast_rate_hz": self.settings.BROADCAST_RATE_HZ,
        }
