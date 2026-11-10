"""
Pydantic data models for the Telemetry Microservice.

Strict adherence to requirement:
- No mocks, stubs or fake default values.
- Unreceived or unassigned values are strictly None (null in JSON).
- Channel and sub-system quality flags explicitly indicate state (GOOD, STALE, NO_SIGNAL, ERROR, NO_DATA).
"""

from datetime import datetime, timezone
from enum import Enum
from typing import Dict, List, Optional
from pydantic import BaseModel, Field


class ConnectionStatus(str, Enum):
    """Overall simulator connection health state."""
    CONNECTED = "CONNECTED"
    STALE = "STALE"
    OFFLINE = "OFFLINE"
    ERROR = "ERROR"
    REPLAY = "REPLAY"


class ChannelQuality(str, Enum):
    """Quality and freshness flag for individual channels and subsystems."""
    GOOD = "GOOD"            # Active, received within stale threshold
    STALE = "STALE"          # Previously received, but older than stale threshold
    NO_SIGNAL = "NO_SIGNAL"  # Never received or lost
    ERROR = "ERROR"          # Corrupted packet or invalid data
    NO_DATA = "NO_DATA"      # Channel received, but all relevant indices were -999.0 / unassigned


class Speeds(BaseModel):
    """Airspeed and groundspeed measurements (X-Plane Channel 3)."""
    indicated_airspeed_kt: Optional[float] = Field(None, description="Indicated airspeed in knots (KIAS)")
    equivalent_airspeed_kt: Optional[float] = Field(None, description="Equivalent airspeed in knots (KEAS)")
    true_airspeed_kt: Optional[float] = Field(None, description="True airspeed in knots (KTAS)")
    groundspeed_kt: Optional[float] = Field(None, description="Groundspeed in knots (KTGS)")
    indicated_airspeed_mph: Optional[float] = Field(None, description="Indicated airspeed in mph")
    true_airspeed_mph: Optional[float] = Field(None, description="True airspeed in mph")
    groundspeed_mph: Optional[float] = Field(None, description="Groundspeed in mph")
    quality: ChannelQuality = Field(ChannelQuality.NO_SIGNAL, description="Subsystem data quality")
    last_update: Optional[datetime] = Field(None, description="UTC timestamp of last update")


class Attitude(BaseModel):
    """Aircraft pitch, roll, and heading (X-Plane Channel 17)."""
    pitch_deg: Optional[float] = Field(None, description="Pitch angle in degrees (+ nose up, - nose down)")
    roll_deg: Optional[float] = Field(None, description="Roll / bank angle in degrees (+ right wing down)")
    heading_true_deg: Optional[float] = Field(None, description="True heading in degrees (0-360)")
    heading_mag_deg: Optional[float] = Field(None, description="Magnetic heading in degrees (0-360)")
    quality: ChannelQuality = Field(ChannelQuality.NO_SIGNAL, description="Subsystem data quality")
    last_update: Optional[datetime] = Field(None, description="UTC timestamp of last update")


class Position(BaseModel):
    """Geographic coordinates, altitude, and runway contact (X-Plane Channel 20)."""
    latitude: Optional[float] = Field(None, description="Latitude in decimal degrees (-90 to +90)")
    longitude: Optional[float] = Field(None, description="Longitude in decimal degrees (-180 to +180)")
    altitude_msl_ft: Optional[float] = Field(None, description="Altitude Mean Sea Level in feet")
    altitude_agl_ft: Optional[float] = Field(None, description="Altitude Above Ground Level in feet")
    on_runway: Optional[bool] = Field(None, description="True if aircraft wheels are on runway surface")
    altitude_ind_ft: Optional[float] = Field(None, description="Indicated altitude in feet")
    quality: ChannelQuality = Field(ChannelQuality.NO_SIGNAL, description="Subsystem data quality")
    last_update: Optional[datetime] = Field(None, description="UTC timestamp of last update")


class Dynamics(BaseModel):
    """Vertical speed, acceleration, G-forces, and aerodynamic angles (X-Plane Channels 4 & 18)."""
    vertical_speed_fpm: Optional[float] = Field(None, description="Vertical velocity in feet per minute (VVI)")
    mach_number: Optional[float] = Field(None, description="Mach flight number")
    g_load_normal: Optional[float] = Field(None, description="Normal G load (vertical load factor)")
    g_load_axial: Optional[float] = Field(None, description="Axial / longitudinal G load")
    g_load_side: Optional[float] = Field(None, description="Side / lateral G load")
    aoa_alpha_deg: Optional[float] = Field(None, description="Angle of Attack (alpha) in degrees")
    sideslip_beta_deg: Optional[float] = Field(None, description="Sideslip angle (beta) in degrees")
    hpath_deg: Optional[float] = Field(None, description="Horizontal flight path angle in degrees")
    vpath_deg: Optional[float] = Field(None, description="Vertical flight path angle in degrees")
    quality: ChannelQuality = Field(ChannelQuality.NO_SIGNAL, description="Subsystem data quality")
    last_update: Optional[datetime] = Field(None, description="UTC timestamp of last update")


class Controls(BaseModel):
    """Flight control positions and surface deflections (X-Plane Channels 8, 13 & 14)."""
    elevator: Optional[float] = Field(None, description="Elevator stick command ratio (-1.0 to +1.0)")
    aileron: Optional[float] = Field(None, description="Aileron stick command ratio (-1.0 to +1.0)")
    rudder: Optional[float] = Field(None, description="Rudder pedal command ratio (-1.0 to +1.0)")
    elevator_trim: Optional[float] = Field(None, description="Elevator trim ratio (-1.0 to +1.0)")
    aileron_trim: Optional[float] = Field(None, description="Aileron trim ratio (-1.0 to +1.0)")
    rudder_trim: Optional[float] = Field(None, description="Rudder trim ratio (-1.0 to +1.0)")
    flap_ratio: Optional[float] = Field(None, description="Flap extension ratio (0.0 to 1.0)")
    gear_ratio: Optional[float] = Field(None, description="Gear extension ratio (0.0 retracted, 1.0 extended)")
    speedbrake_ratio: Optional[float] = Field(None, description="Speedbrake / spoiler ratio (0.0 to 1.0)")
    slat_ratio: Optional[float] = Field(None, description="Slat deployment ratio (0.0 to 1.0)")
    quality: ChannelQuality = Field(ChannelQuality.NO_SIGNAL, description="Subsystem data quality")
    last_update: Optional[datetime] = Field(None, description="UTC timestamp of last update")


class Engine(BaseModel):
    """Engine operating metrics and powerplant parameters (X-Plane Channels 25, 26, 37, 39, 43, 47, 62)."""
    throttle_ratio: Optional[float] = Field(None, description="Throttle command ratio (0.0 to 1.0)")
    rpm: Optional[float] = Field(None, description="Engine / propeller revolutions per minute")
    engine_power_ratio: Optional[float] = Field(None, description="Engine actual power ratio (0.0 to 1.0)")
    fuel_flow_gph: Optional[float] = Field(None, description="Fuel flow in gallons per hour")
    fuel_flow_pph: Optional[float] = Field(None, description="Fuel flow in pounds per hour")
    oil_pressure_psi: Optional[float] = Field(None, description="Engine oil pressure in psi")
    oil_temp_degc: Optional[float] = Field(None, description="Engine oil temperature in Celsius")
    egt_degc: Optional[float] = Field(None, description="Exhaust gas temperature in Celsius")
    fuel_quantity_gal: Optional[float] = Field(None, description="Total fuel quantity in gallons")
    quality: ChannelQuality = Field(ChannelQuality.NO_SIGNAL, description="Subsystem data quality")
    last_update: Optional[datetime] = Field(None, description="UTC timestamp of last update")


class FlightTimes(BaseModel):
    """Simulation clock and flight duration (X-Plane Channel 0 or total time)."""
    total_time_sec: Optional[float] = Field(None, description="Total simulator flight time in seconds")
    zulu_time_sec: Optional[float] = Field(None, description="Zulu / UTC simulator time in seconds past midnight")
    local_time_sec: Optional[float] = Field(None, description="Local simulator time in seconds past midnight")
    frame_rate_fps: Optional[float] = Field(None, description="Simulator actual frame rate in FPS")
    quality: ChannelQuality = Field(ChannelQuality.NO_SIGNAL, description="Subsystem data quality")
    last_update: Optional[datetime] = Field(None, description="UTC timestamp of last update")


class SimulatorStatus(BaseModel):
    """Network connection, packet statistics, and simulator health metadata."""
    connection: ConnectionStatus = Field(ConnectionStatus.OFFLINE, description="Simulator connection state")
    packet_rate_hz: float = Field(0.0, description="Measured incoming UDP packet rate in Hertz")
    packets_received: int = Field(0, description="Total valid UDP packets received since startup")
    packets_dropped: int = Field(0, description="Estimated packet drops / gaps")
    packets_corrupted: int = Field(0, description="Packets rejected due to bad header or truncated payload")
    packet_loss_rate: float = Field(0.0, description="Estimated packet loss ratio (0.0 to 1.0)")
    last_packet_time: Optional[datetime] = Field(None, description="UTC timestamp of most recent UDP packet")
    time_since_last_packet_sec: Optional[float] = Field(None, description="Elapsed seconds since last packet")
    channel_freshness: Dict[int, ChannelQuality] = Field(default_factory=dict, description="Freshness per X-Plane channel")
    replay_mode: bool = Field(False, description="True if running in recorded flight data replay mode")
    replay_progress_pct: Optional[float] = Field(None, description="Replay dataset progress percentage (0-100%)")
    errors: List[str] = Field(default_factory=list, description="Active connection and parser error messages")


class TelemetrySnapshot(BaseModel):
    """Comprehensive real-time telemetry snapshot consumed by Gateway and downstream clients."""
    timestamp: datetime = Field(default_factory=lambda: datetime.now(timezone.utc), description="Snapshot creation time UTC")
    status: SimulatorStatus = Field(default_factory=SimulatorStatus, description="Simulator status and metrics")
    speeds: Speeds = Field(default_factory=Speeds, description="Airspeeds")
    attitude: Attitude = Field(default_factory=Attitude, description="Attitude and orientation")
    position: Position = Field(default_factory=Position, description="Coordinates and elevation")
    dynamics: Dynamics = Field(default_factory=Dynamics, description="Aerodynamic vectors and G-loads")
    controls: Controls = Field(default_factory=Controls, description="Flight controls and surfaces")
    engine: Engine = Field(default_factory=Engine, description="Powerplant indicators")
    flight_times: FlightTimes = Field(default_factory=FlightTimes, description="Clocks and frame rates")
    raw_channels: Dict[int, List[Optional[float]]] = Field(
        default_factory=dict,
        description="Preserved raw unpacked channel values (with -999.0 resolved to null)"
    )


class ReplayControlRequest(BaseModel):
    """Payload to control the flight replay engine."""
    action: str = Field(..., description="Action to perform: 'start', 'stop', 'restart', 'set_speed'")
    speed: Optional[float] = Field(None, description="Playback speed multiplier (e.g. 1.0, 2.0, 0.5)")
    loop: Optional[bool] = Field(None, description="Whether to loop the dataset continuously")
    file_path: Optional[str] = Field(None, description="Optional custom path to flight data file")


class HealthResponse(BaseModel):
    """Service health response schema."""
    service: str
    status: str
    simulator_connection: ConnectionStatus
    packets_received: int
    packet_rate_hz: float
    replay_mode: bool
    timestamp: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
