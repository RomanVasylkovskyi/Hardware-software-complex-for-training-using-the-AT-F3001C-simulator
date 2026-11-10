"""
Configuration settings for the Telemetry Microservice.
Loads environment variables with fallback defaults.
"""

from functools import lru_cache
from pathlib import Path
from typing import Optional
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Telemetry service configuration settings."""

    # Service identification
    service_name: str = "telemetry-service"
    environment: str = "production"
    debug: bool = False

    # UDP Listener configuration (X-Plane 11 input)
    udp_host: str = "0.0.0.0"
    udp_port: int = 49000
    udp_buffer_size: int = 65535

    # HTTP & WebSocket Server configuration (Gateway & Client facing)
    http_host: str = "0.0.0.0"
    http_port: int = 8001

    # Replay configuration (Real flight data replay engine)
    replay_mode: bool = False
    replay_file_path: str = "../../data/telemetry_essential.csv"
    replay_speed: float = 1.0
    replay_loop: bool = True

    # Telemetry health, staleness and timeouts
    channel_stale_timeout_sec: float = 1.0
    simulator_offline_timeout_sec: float = 3.0
    expected_packet_interval_sec: float = 0.05  # ~20 Hz nominal rate

    # WebSocket streaming rate
    ws_broadcast_rate_hz: float = 20.0

    model_config = SettingsConfigDict(
        env_prefix="TELEM_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )


@lru_cache()
def get_settings() -> Settings:
    """Return a cached instance of service settings."""
    return Settings()


# Default singleton instance
settings = get_settings()
