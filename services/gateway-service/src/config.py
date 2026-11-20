"""
Configuration settings for the Gateway Aggregator Service.
Loaded from environment variables with sensible defaults.
"""

import os
from pathlib import Path
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # Service host & port
    HOST: str = "0.0.0.0"
    PORT: int = 8000

    # Upstream Microservice Endpoints matching server.py definitions
    TELEMETRY_WS_URL: str = "ws://telemetry-service:8001/ws/telemetry"
    TELEMETRY_HTTP_URL: str = "http://telemetry-service:8001"


    ANALYTICS_WS_URL: str = "ws://analytics-service:8003/ws/analytics"
    ANALYTICS_HTTP_URL: str = "http://analytics-service:8003"

    # Streaming and timing parameters.
    # Clients get a payload as soon as new upstream data arrives, at most BROADCAST_RATE_HZ
    # times per second, and at least every BROADCAST_HEARTBEAT_SEC (status refresh).
    BROADCAST_RATE_HZ: float = 30.0
    BROADCAST_HEARTBEAT_SEC: float = 0.25
    HEARTBEAT_TIMEOUT_SEC: float = 1.2  # Max seconds before marking upstream as OFFLINE
    RECONNECT_DELAY_SEC: float = 1.5
    ANALYTICS_QUEUE_SIZE: int = 500

    # Shared secret for control endpoints (replay start/stop/upload, live mode).
    # Empty = control endpoints are open (development only; a warning is logged).
    INSTRUCTOR_TOKEN: str = ""

    # Static Web Client Path
    STATIC_DIR: str = ""

    # Airport reference defaults
    AIRPORT_ICAO: str = "UKLL"
    RUNWAY_IDENT: str = "13"

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore"
    )

    def resolve_static_dir(self) -> Path:
        """Resolve the path to the instructor-panel static files."""
        if self.STATIC_DIR:
            p = Path(self.STATIC_DIR)
            if p.exists():
                return p

        # Check Docker standard path
        docker_path = Path("/app/clients/instructor-panel")
        if docker_path.exists():
            return docker_path

        # Check repo relative path: ../../clients/instructor-panel
        current_dir = Path(__file__).resolve().parent
        repo_root = current_dir.parent.parent.parent
        repo_client = repo_root / "clients" / "instructor-panel"
        if repo_client.exists():
            return repo_client

        # Local fallback to sibling directory
        sibling_client = current_dir.parent.parent / "clients" / "instructor-panel"
        if sibling_client.exists():
            return sibling_client

        return repo_client


settings = Settings()
