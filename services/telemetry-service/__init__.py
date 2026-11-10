"""
Telemetry Service Package for AT-F3001C Hardware-Software Complex.
"""

try:
    from .config import Settings, settings
    from .models import (
        Attitude,
        ChannelQuality,
        ConnectionStatus,
        Controls,
        Dynamics,
        Engine,
        FlightTimes,
        HealthResponse,
        Position,
        ReplayControlRequest,
        SimulatorStatus,
        Speeds,
        TelemetrySnapshot,
    )
    from .parser import TelemetryParser, is_xplane_null, parse_xplane_datagram
    from .replay import FlightDataReplayer, pack_real_row_to_xplane_udp
except (ImportError, ValueError):
    from config import Settings, settings
    from models import (
        Attitude,
        ChannelQuality,
        ConnectionStatus,
        Controls,
        Dynamics,
        Engine,
        FlightTimes,
        HealthResponse,
        Position,
        ReplayControlRequest,
        SimulatorStatus,
        Speeds,
        TelemetrySnapshot,
    )
    from parser import TelemetryParser, is_xplane_null, parse_xplane_datagram
    from replay import FlightDataReplayer, pack_real_row_to_xplane_udp

__all__ = [
    "Settings",
    "settings",
    "ConnectionStatus",
    "ChannelQuality",
    "Speeds",
    "Attitude",
    "Position",
    "Dynamics",
    "Controls",
    "Engine",
    "FlightTimes",
    "SimulatorStatus",
    "TelemetrySnapshot",
    "ReplayControlRequest",
    "HealthResponse",
    "TelemetryParser",
    "parse_xplane_datagram",
    "is_xplane_null",
    "FlightDataReplayer",
    "pack_real_row_to_xplane_udp",
]
