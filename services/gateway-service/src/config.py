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

    VISION_WS_URL: str = "ws://vision-service:8002/ws/vision"
    VISION_HTTP_URL: str = "http://vision-service:8002"

    ANALYTICS_WS_URL: str = "ws://analytics-service:8003/ws/analytics"
    ANALYTICS_HTTP_URL: str = "http://analytics-service:8003"

    # Streaming and timing parameters
    BROADCAST_RATE_HZ: float = 25.0  # 25 Hz -> ~40ms period (<50ms latency)
    HEARTBEAT_TIMEOUT_SEC: float = 1.2  # Max seconds before marking upstream as OFFLINE
    RECONNECT_DELAY_SEC: float = 1.5

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
