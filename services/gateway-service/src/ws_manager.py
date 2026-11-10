"""
WebSocket Client Manager and High-Rate Unified Stream Broadcaster.
Broadcasts unified avionics payloads to instructor panels and tablet displays
at 20-30 Hz (<50ms latency target).
"""

import asyncio
import json
import logging
import time
from typing import Any, Dict, Set

from fastapi import WebSocket, WebSocketDisconnect

try:
    from .aggregator import StreamAggregator
    from .config import Settings
except ImportError:
    from aggregator import StreamAggregator
    from config import Settings

logger = logging.getLogger("gateway.ws_manager")


class WebSocketManager:
    def __init__(self, settings: Settings, aggregator: StreamAggregator):
        self.settings = settings
        self.aggregator = aggregator
        self.active_connections: Set[WebSocket] = set()
        self.running = False
        self._broadcast_task: asyncio.Task | None = None

        # Telemetry metrics
        self.broadcast_ticks: int = 0
        self.actual_hz: float = 0.0
        self._hz_tick_count: int = 0
        self._hz_last_time: float = time.time()

    async def start(self) -> None:
        """Start the high-frequency broadcast loop."""
        if self.running:
            return
        self.running = True
        self._hz_last_time = time.time()
        self._broadcast_task = asyncio.create_task(
            self._broadcast_loop(), name="gateway_broadcast_loop"
        )
        logger.info(
            "WebSocket broadcast loop started at target rate %.1f Hz",
            self.settings.BROADCAST_RATE_HZ,
        )

    async def stop(self) -> None:
        """Stop the broadcast loop and disconnect clients cleanly."""
        self.running = False
        if self._broadcast_task:
            self._broadcast_task.cancel()
            try:
                await self._broadcast_task
            except asyncio.CancelledError:
                pass
            self._broadcast_task = None

        # Close all active connections
        for ws in list(self.active_connections):
            try:
                await ws.close(code=1001, reason="Server shutting down")
            except Exception:
                pass
        self.active_connections.clear()
        logger.info("WebSocket broadcast loop stopped.")

    async def connect(self, websocket: WebSocket) -> None:
        """Accept a new client connection."""
        await websocket.accept()
        self.active_connections.add(websocket)
        logger.info(
            "Client connected. Active clients: %d", len(self.active_connections)
        )

    def disconnect(self, websocket: WebSocket) -> None:
        """Remove a disconnected client."""
        self.active_connections.discard(websocket)
        logger.info(
            "Client disconnected. Active clients: %d",
            len(self.active_connections),
        )

    async def handle_client_message(
        self, websocket: WebSocket, text: str
    ) -> None:
        """
        Handle incoming messages from clients (e.g. ping for latency measurement).
        """
        try:
            data = json.loads(text)
            msg_type = data.get("type")

            if msg_type == "ping":
                # Immediately reply with pong containing client timestamp and server timestamp
                client_t = data.get("t", 0.0)
                await websocket.send_text(
                    json.dumps(
                        {
                            "type": "pong",
                            "client_t": client_t,
                            "server_t": time.time(),
                        }
                    )
                )
            elif msg_type == "command":
                logger.info("Received command from client: %s", data)
                # Future expansion: simulator controls, freezes, repositioning
        except Exception as e:
            logger.warning("Error processing client message: %s", e)

    async def _broadcast_loop(self) -> None:
        """
        Broadcasting loop executing at 20-30 Hz (default 25 Hz / 40ms interval).
        Measures execution time to guarantee low latency (<50ms).
        """
        target_hz = max(1.0, self.settings.BROADCAST_RATE_HZ)
        period = 1.0 / target_hz

        while self.running:
            start_tick = time.perf_counter()

            # Only do serialization and network I/O if there are connected clients or for diagnostics
            if self.active_connections:
                payload = self.aggregator.get_unified_payload()
                payload["type"] = "telemetry_snapshot"
                payload["connected_clients"] = len(self.active_connections)
                payload["measured_hz"] = round(self.actual_hz, 1)

                try:
                    payload_json = json.dumps(payload, separators=(",", ":"))
                except Exception as json_err:
                    logger.error("Failed to serialize unified payload: %s", json_err)
                    payload_json = None

                if payload_json:
                    # Broadcast to all clients concurrently
                    dead_clients: list[WebSocket] = []
                    results = await asyncio.gather(
                        *[
                            self._send_safe(ws, payload_json)
                            for ws in list(self.active_connections)
                        ],
                        return_exceptions=True,
                    )

                    for ws, res in zip(list(self.active_connections), results):
                        if res is False or isinstance(res, Exception):
                            dead_clients.append(ws)

                    for dead_ws in dead_clients:
                        self.active_connections.discard(dead_ws)

            self.broadcast_ticks += 1
            self._hz_tick_count += 1

            # Update running Hz calculation every second
            now = time.time()
            dt = now - self._hz_last_time
            if dt >= 1.0:
                self.actual_hz = self._hz_tick_count / dt
                self._hz_tick_count = 0
                self._hz_last_time = now

            elapsed = time.perf_counter() - start_tick
            sleep_time = max(0.001, period - elapsed)
            try:
                await asyncio.sleep(sleep_time)
            except asyncio.CancelledError:
                break

    async def _send_safe(self, ws: WebSocket, text: str) -> bool:
        """Send message safely; returns False if connection is broken."""
        try:
            await ws.send_text(text)
            return True
        except (WebSocketDisconnect, RuntimeError, ConnectionResetError, OSError):
            return False
        except Exception as e:
            logger.debug("Send failed to client: %s", e)
            return False

    def get_stats(self) -> Dict[str, Any]:
        return {
            "connected_clients": len(self.active_connections),
            "broadcast_ticks": self.broadcast_ticks,
            "measured_hz": round(self.actual_hz, 1),
            "target_hz": self.settings.BROADCAST_RATE_HZ,
        }
