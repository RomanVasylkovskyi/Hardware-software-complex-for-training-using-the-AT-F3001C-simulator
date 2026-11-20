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
    SEND_TIMEOUT_SEC = 0.5

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
        Push the unified payload as soon as fresh upstream data arrives (no polling delay),
        capped at BROADCAST_RATE_HZ, with a heartbeat every BROADCAST_HEARTBEAT_SEC so that
        OFFLINE/stale transitions still reach the clients.
        """
        min_interval = 1.0 / max(1.0, self.settings.BROADCAST_RATE_HZ)
        heartbeat = max(min_interval, self.settings.BROADCAST_HEARTBEAT_SEC)
        loop = asyncio.get_running_loop()
        last_sent = 0.0
        update_event = self.aggregator.update_event

        while self.running:
            try:
                await asyncio.wait_for(update_event.wait(), timeout=heartbeat)
            except asyncio.TimeoutError:
                pass
            except asyncio.CancelledError:
                break
            update_event.clear()

            wait = min_interval - (loop.time() - last_sent)
            if wait > 0:
                try:
                    await asyncio.sleep(wait)
                except asyncio.CancelledError:
                    break

            clients = list(self.active_connections)
            if clients:
                payload = self.aggregator.get_unified_payload()
                payload["connected_clients"] = len(clients)
                payload["measured_hz"] = round(self.actual_hz, 1)
                try:
                    payload_json = json.dumps(payload, separators=(",", ":"))
                except (TypeError, ValueError) as json_err:
                    logger.error("Failed to serialize unified payload: %s", json_err)
                    payload_json = None

                if payload_json:
                    results = await asyncio.gather(
                        *[self._send_safe(ws, payload_json) for ws in clients],
                        return_exceptions=True,
                    )
                    for ws, res in zip(clients, results):
                        if res is not True:
                            self.active_connections.discard(ws)
            last_sent = loop.time()

            self.broadcast_ticks += 1
            self._hz_tick_count += 1
            now = time.time()
            dt = now - self._hz_last_time
            if dt >= 1.0:
                self.actual_hz = self._hz_tick_count / dt
                self._hz_tick_count = 0
                self._hz_last_time = now

    async def _send_safe(self, ws: WebSocket, text: str) -> bool:
        """Send with a timeout: one stalled tablet must not hold back every other client."""
        try:
            await asyncio.wait_for(ws.send_text(text), timeout=self.SEND_TIMEOUT_SEC)
            return True
        except asyncio.TimeoutError:
            logger.warning("Dropping WebSocket client: send timed out")
        except (WebSocketDisconnect, RuntimeError, ConnectionError) as e:
            logger.info("Dropping WebSocket client: %s", e)
        try:
            await ws.close(code=1011)
        except (RuntimeError, ConnectionError):
            pass
        return False

    def get_stats(self) -> Dict[str, Any]:
        return {
            "connected_clients": len(self.active_connections),
            "broadcast_ticks": self.broadcast_ticks,
            "measured_hz": round(self.actual_hz, 1),
            "target_hz": self.settings.BROADCAST_RATE_HZ,
        }
