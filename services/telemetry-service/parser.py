"""
Real binary parser for X-Plane 11 UDP packets.

Protocol details:
- Standard port: 49000
- Packet header: b'DATA\x00' (5 bytes)
- Payload: N records of 36 bytes each (total packet length: 5 + N * 36)
- Record structure:
    - 4 bytes int32 (channel ID, little-endian)
    - 32 bytes 8 x float32 (values, little-endian)
- Unassigned / empty channel indices send -999.0:
    - Parsed strictly as None (never 0.0 or synthetic defaults).
- Tracks per-channel timestamps, packet arrival rates, dropped packets, and data staleness.
"""

from collections import deque
from datetime import datetime, timezone
import math
import struct
import time
from typing import Dict, List, Optional, Tuple

try:
    from .models import (
        Attitude,
        ChannelQuality,
        ConnectionStatus,
        Controls,
        Dynamics,
        Engine,
        FlightTimes,
        Position,
        SimulatorStatus,
        Speeds,
        TelemetrySnapshot,
    )
except ImportError:
    from models import (
        Attitude,
        ChannelQuality,
        ConnectionStatus,
        Controls,
        Dynamics,
        Engine,
        FlightTimes,
        Position,
        SimulatorStatus,
        Speeds,
        TelemetrySnapshot,
    )


# X-Plane 11 UDP binary constants
XPLANE_DATA_HEADER = b"DATA\x00"
RECORD_BYTE_SIZE = 36  # 4 bytes int32 + 8 * 4 bytes float32
XPLANE_NULL_VALUE = -999.0
NULL_FLOAT_TOLERANCE = 1e-2


def is_xplane_null(value: float) -> bool:
    """
    Check if an X-Plane float value represents an unassigned/empty sentinel (-999.0)
    or invalid float (NaN / Inf).
    """
    if math.isnan(value) or math.isinf(value):
        return True
    return abs(value - XPLANE_NULL_VALUE) < NULL_FLOAT_TOLERANCE


def parse_xplane_datagram(data: bytes) -> Tuple[Optional[Dict[int, List[Optional[float]]]], Optional[str]]:
    """
    Parse a raw X-Plane 11 UDP datagram into channel records.
    Returns (channel_data_dict, error_string).
    """
    if len(data) < 5:
        return None, f"Datagram too short ({len(data)} bytes, min required is 5 bytes)"

    header = data[:5]
    if header != XPLANE_DATA_HEADER:
        return None, f"Invalid packet header: {header!r}, expected {XPLANE_DATA_HEADER!r}"

    payload = data[5:]
    if len(payload) % RECORD_BYTE_SIZE != 0:
        return None, (
            f"Corrupted payload size: {len(payload)} bytes is not a multiple of {RECORD_BYTE_SIZE} "
            f"(extra {len(payload) % RECORD_BYTE_SIZE} bytes)"
        )

    num_records = len(payload) // RECORD_BYTE_SIZE
    channels: Dict[int, List[Optional[float]]] = {}

    for i in range(num_records):
        offset = i * RECORD_BYTE_SIZE
        record_bytes = payload[offset : offset + RECORD_BYTE_SIZE]

        # Unpack: int32 channel, followed by 8 float32 values
        try:
            channel_id, *raw_floats = struct.unpack("<i8f", record_bytes)
        except struct.error as e:
            return None, f"Struct unpack error at record {i}: {e}"

        parsed_values: List[Optional[float]] = []
        for val in raw_floats:
            if is_xplane_null(val):
                parsed_values.append(None)
            else:
                # Store cleaned float rounded to 5 decimal places for numerical stability
                parsed_values.append(round(float(val), 5))

        channels[channel_id] = parsed_values

    return channels, None


class TelemetryParser:
    """
    Stateful telemetry parser that aggregates incoming X-Plane packets,
    tracks per-channel freshness, packet rates, dropped packets,
    and constructs strict TelemetrySnapshot objects.
    """

    def __init__(
        self,
        stale_timeout_sec: float = 1.0,
        offline_timeout_sec: float = 3.0,
        expected_interval_sec: float = 0.05,
    ):
        self.stale_timeout_sec = stale_timeout_sec
        self.offline_timeout_sec = offline_timeout_sec
        self.expected_interval_sec = expected_interval_sec

        # Raw channel state
        self._raw_channels: Dict[int, List[Optional[float]]] = {}
        self._channel_last_seen: Dict[int, float] = {}

        # Packet reception statistics
        self._packets_received = 0
        self._packets_corrupted = 0
        self._packets_dropped = 0
        self._last_packet_monotonic: Optional[float] = None
        self._last_packet_wallclock: Optional[datetime] = None
        self._recent_packet_times: deque = deque(maxlen=100)

        # Active errors log
        self._active_errors: List[str] = []

        # Replay mode tracking
        self.replay_mode = False
        self.replay_progress_pct: Optional[float] = None

    def reset(self) -> None:
        """Reset parser state."""
        self._raw_channels.clear()
        self._channel_last_seen.clear()
        self._packets_received = 0
        self._packets_corrupted = 0
        self._packets_dropped = 0
        self._last_packet_monotonic = None
        self._last_packet_wallclock = None
        self._recent_packet_times.clear()
        self._active_errors.clear()
        self.replay_progress_pct = None

    def process_packet(
        self, data: bytes, receive_monotonic: Optional[float] = None
    ) -> Tuple[Optional[TelemetrySnapshot], Optional[str]]:
        """
        Ingest a raw binary UDP packet from X-Plane.
        Returns (snapshot, error_message).
        """
        now = receive_monotonic if receive_monotonic is not None else time.monotonic()
        now_dt = datetime.now(timezone.utc)

        channels, err = parse_xplane_datagram(data)
        if err:
            self._packets_corrupted += 1
            if err not in self._active_errors:
                self._active_errors.append(err)
                # Keep active errors list bounded
                if len(self._active_errors) > 10:
                    self._active_errors.pop(0)
            return None, err

        # Successful packet receipt
        self._packets_received += 1
        self._recent_packet_times.append(now)

        # Detect packet gaps / drops
        if self._last_packet_monotonic is not None:
            gap = now - self._last_packet_monotonic
            # If gap > 2.5x expected interval and gap < offline threshold, estimate dropped packets
            if gap > (self.expected_interval_sec * 2.5) and gap < self.offline_timeout_sec:
                dropped_in_gap = max(1, int(round(gap / self.expected_interval_sec)) - 1)
                self._packets_dropped += dropped_in_gap

        self._last_packet_monotonic = now
        self._last_packet_wallclock = now_dt

        # Update per-channel data and timestamps
        assert channels is not None
        for ch_id, values in channels.items():
            self._raw_channels[ch_id] = values
            self._channel_last_seen[ch_id] = now

        # Clear resolved connection errors
        self._active_errors = [e for e in self._active_errors if not e.startswith("Simulator connection")]

        snapshot = self._build_snapshot(now=now, now_dt=now_dt)
        return snapshot, None

    def check_staleness(
        self, now_monotonic: Optional[float] = None
    ) -> TelemetrySnapshot:
        """
        Evaluate channel staleness and connection status against the current time.
        Called periodically by server watchdog.
        """
        now = now_monotonic if now_monotonic is not None else time.monotonic()
        now_dt = datetime.now(timezone.utc)
        return self._build_snapshot(now=now, now_dt=now_dt)

    def _calculate_packet_rate(self, now: float) -> float:
        """Calculate incoming packet rate in Hz over recent packet window."""
        # Purge packet timestamps older than 2.0s
        while self._recent_packet_times and (now - self._recent_packet_times[0]) > 2.0:
            self._recent_packet_times.popleft()

        if len(self._recent_packet_times) < 2:
            return 0.0

        time_span = self._recent_packet_times[-1] - self._recent_packet_times[0]
        if time_span <= 0:
            return 0.0

        return round((len(self._recent_packet_times) - 1) / time_span, 1)

    def _determine_channel_quality(self, channel_id: int, now: float) -> ChannelQuality:
        """Evaluate quality for a specific X-Plane channel."""
        if channel_id not in self._channel_last_seen:
            return ChannelQuality.NO_SIGNAL

        age = now - self._channel_last_seen[channel_id]
        if age > self.stale_timeout_sec:
            return ChannelQuality.STALE

        values = self._raw_channels.get(channel_id, [])
        if not values or all(v is None for v in values):
            return ChannelQuality.NO_DATA

        return ChannelQuality.GOOD

    def _build_snapshot(self, now: float, now_dt: datetime) -> TelemetrySnapshot:
        """Construct the complete TelemetrySnapshot from current parser state."""
        packet_rate = self._calculate_packet_rate(now)

        # Connection status determination
        time_since_last_packet: Optional[float] = None
        if self._last_packet_monotonic is not None:
            time_since_last_packet = round(now - self._last_packet_monotonic, 3)

        errors_copy = list(self._active_errors)

        if self._last_packet_monotonic is None:
            conn_status = ConnectionStatus.REPLAY if self.replay_mode else ConnectionStatus.OFFLINE
            if not self.replay_mode:
                msg = "No telemetry received from simulator (offline)"
                if msg not in errors_copy:
                    errors_copy.append(msg)
        elif time_since_last_packet is not None and time_since_last_packet > self.offline_timeout_sec:
            conn_status = ConnectionStatus.OFFLINE
            msg = f"Simulator connection lost (no packets for {time_since_last_packet:.1f}s)"
            if msg not in errors_copy:
                errors_copy.append(msg)
        elif time_since_last_packet is not None and time_since_last_packet > self.stale_timeout_sec:
            conn_status = ConnectionStatus.STALE
        else:
            conn_status = ConnectionStatus.REPLAY if self.replay_mode else ConnectionStatus.CONNECTED

        # Packet loss calculation
        total_expected = self._packets_received + self._packets_dropped
        loss_rate = (
            round(self._packets_dropped / total_expected, 4)
            if total_expected > 0
            else 0.0
        )

        # Freshness map for all channels ever seen
        channel_freshness: Dict[int, ChannelQuality] = {}
        for ch_id in self._raw_channels.keys():
            channel_freshness[ch_id] = self._determine_channel_quality(ch_id, now)

        status = SimulatorStatus(
            connection=conn_status,
            packet_rate_hz=packet_rate,
            packets_received=self._packets_received,
            packets_dropped=self._packets_dropped,
            packets_corrupted=self._packets_corrupted,
            packet_loss_rate=loss_rate,
            last_packet_time=self._last_packet_wallclock,
            time_since_last_packet_sec=time_since_last_packet,
            channel_freshness=channel_freshness,
            replay_mode=self.replay_mode,
            replay_progress_pct=self.replay_progress_pct,
            errors=errors_copy,
        )

        # ----------------- Channel 3: Speeds -----------------
        ch3_quality = self._determine_channel_quality(3, now)
        ch3 = self._raw_channels.get(3, [None] * 8)
        speeds = Speeds(
            indicated_airspeed_kt=ch3[0] if len(ch3) > 0 else None,
            equivalent_airspeed_kt=ch3[1] if len(ch3) > 1 else None,
            true_airspeed_kt=ch3[2] if len(ch3) > 2 else None,
            groundspeed_kt=ch3[3] if len(ch3) > 3 else None,
            indicated_airspeed_mph=ch3[4] if len(ch3) > 4 else None,
            true_airspeed_mph=ch3[5] if len(ch3) > 5 else None,
            groundspeed_mph=ch3[6] if len(ch3) > 6 else None,
            quality=ch3_quality,
            last_update=now_dt if ch3_quality == ChannelQuality.GOOD else None,
        )

        # ----------------- Channel 17: Attitude -----------------
        ch17_quality = self._determine_channel_quality(17, now)
        ch17 = self._raw_channels.get(17, [None] * 8)
        attitude = Attitude(
            pitch_deg=ch17[0] if len(ch17) > 0 else None,
            roll_deg=ch17[1] if len(ch17) > 1 else None,
            heading_true_deg=ch17[2] if len(ch17) > 2 else None,
            heading_mag_deg=ch17[3] if len(ch17) > 3 else None,
            quality=ch17_quality,
            last_update=now_dt if ch17_quality == ChannelQuality.GOOD else None,
        )

        # ----------------- Channel 20: Position -----------------
        ch20_quality = self._determine_channel_quality(20, now)
        ch20 = self._raw_channels.get(20, [None] * 8)
        on_runway_val: Optional[bool] = None
        if len(ch20) > 4 and ch20[4] is not None:
            on_runway_val = bool(round(ch20[4]))

        position = Position(
            latitude=ch20[0] if len(ch20) > 0 else None,
            longitude=ch20[1] if len(ch20) > 1 else None,
            altitude_msl_ft=ch20[2] if len(ch20) > 2 else None,
            altitude_agl_ft=ch20[3] if len(ch20) > 3 else None,
            on_runway=on_runway_val,
            altitude_ind_ft=ch20[5] if len(ch20) > 5 else None,
            quality=ch20_quality,
            last_update=now_dt if ch20_quality == ChannelQuality.GOOD else None,
        )

        # ----------------- Channels 4 & 18: Dynamics -----------------
        ch4_quality = self._determine_channel_quality(4, now)
        ch18_quality = self._determine_channel_quality(18, now)
        ch4 = self._raw_channels.get(4, [None] * 8)
        ch18 = self._raw_channels.get(18, [None] * 8)

        # Subsystem quality: GOOD if either channel 4 or 18 is GOOD
        if ch4_quality == ChannelQuality.GOOD or ch18_quality == ChannelQuality.GOOD:
            dyn_quality = ChannelQuality.GOOD
        elif ch4_quality == ChannelQuality.STALE or ch18_quality == ChannelQuality.STALE:
            dyn_quality = ChannelQuality.STALE
        elif ch4_quality == ChannelQuality.NO_DATA and ch18_quality == ChannelQuality.NO_DATA:
            dyn_quality = ChannelQuality.NO_DATA
        else:
            dyn_quality = ChannelQuality.NO_SIGNAL

        dynamics = Dynamics(
            mach_number=ch4[0] if len(ch4) > 0 else None,
            vertical_speed_fpm=ch4[1] if len(ch4) > 1 else None,
            g_load_normal=ch4[2] if len(ch4) > 2 else None,
            g_load_axial=ch4[3] if len(ch4) > 3 else None,
            g_load_side=ch4[4] if len(ch4) > 4 else None,
            aoa_alpha_deg=ch18[0] if len(ch18) > 0 else None,
            sideslip_beta_deg=ch18[1] if len(ch18) > 1 else None,
            hpath_deg=ch18[2] if len(ch18) > 2 else None,
            vpath_deg=ch18[3] if len(ch18) > 3 else None,
            quality=dyn_quality,
            last_update=now_dt if dyn_quality == ChannelQuality.GOOD else None,
        )

        # ----------------- Channels 8, 13 & 14: Controls -----------------
        ch8_quality = self._determine_channel_quality(8, now)
        ch13_quality = self._determine_channel_quality(13, now)
        ch14_quality = self._determine_channel_quality(14, now)
        ch8 = self._raw_channels.get(8, [None] * 8)
        ch13 = self._raw_channels.get(13, [None] * 8)
        ch14 = self._raw_channels.get(14, [None] * 8)

        if any(q == ChannelQuality.GOOD for q in (ch8_quality, ch13_quality, ch14_quality)):
            ctrl_quality = ChannelQuality.GOOD
        elif any(q == ChannelQuality.STALE for q in (ch8_quality, ch13_quality, ch14_quality)):
            ctrl_quality = ChannelQuality.STALE
        else:
            ctrl_quality = ChannelQuality.NO_SIGNAL

        controls = Controls(
            elevator=ch8[0] if len(ch8) > 0 else None,
            aileron=ch8[1] if len(ch8) > 1 else None,
            rudder=ch8[2] if len(ch8) > 2 else None,
            elevator_trim=ch13[0] if len(ch13) > 0 else None,
            aileron_trim=ch13[1] if len(ch13) > 1 else None,
            rudder_trim=ch13[2] if len(ch13) > 2 else None,
            flap_ratio=ch13[3] if len(ch13) > 3 else None,
            slat_ratio=ch13[5] if len(ch13) > 5 else None,
            speedbrake_ratio=ch13[6] if len(ch13) > 6 else None,
            gear_ratio=ch14[0] if len(ch14) > 0 else None,
            quality=ctrl_quality,
            last_update=now_dt if ctrl_quality == ChannelQuality.GOOD else None,
        )

        # ----------------- Channels 25, 26, 37, 39, 43, 47, 62: Engine -----------------
        ch25_quality = self._determine_channel_quality(25, now)
        ch26_quality = self._determine_channel_quality(26, now)
        ch37_quality = self._determine_channel_quality(37, now)
        ch39_quality = self._determine_channel_quality(39, now)
        ch43_quality = self._determine_channel_quality(43, now)
        ch47_quality = self._determine_channel_quality(47, now)
        ch62_quality = self._determine_channel_quality(62, now)

        ch25 = self._raw_channels.get(25, [None] * 8)
        ch26 = self._raw_channels.get(26, [None] * 8)
        ch37 = self._raw_channels.get(37, [None] * 8)
        ch39 = self._raw_channels.get(39, [None] * 8)
        ch43 = self._raw_channels.get(43, [None] * 8)
        ch47 = self._raw_channels.get(47, [None] * 8)
        ch62 = self._raw_channels.get(62, [None] * 8)

        eng_qualities = (ch25_quality, ch26_quality, ch37_quality, ch39_quality, ch43_quality, ch47_quality, ch62_quality)
        if any(q == ChannelQuality.GOOD for q in eng_qualities):
            eng_quality = ChannelQuality.GOOD
        elif any(q == ChannelQuality.STALE for q in eng_qualities):
            eng_quality = ChannelQuality.STALE
        else:
            eng_quality = ChannelQuality.NO_SIGNAL

        engine = Engine(
            throttle_ratio=ch25[0] if len(ch25) > 0 else None,
            engine_power_ratio=ch26[0] if len(ch26) > 0 else None,
            rpm=ch37[0] if len(ch37) > 0 else None,
            oil_temp_degc=ch39[0] if len(ch39) > 0 else None,
            oil_pressure_psi=ch39[1] if len(ch39) > 1 else None,
            egt_degc=ch43[0] if len(ch43) > 0 else None,
            fuel_flow_gph=ch47[0] if len(ch47) > 0 else None,
            fuel_quantity_gal=ch62[0] if len(ch62) > 0 else None,
            quality=eng_quality,
            last_update=now_dt if eng_quality == ChannelQuality.GOOD else None,
        )

        # ----------------- Channel 0 & Clock: FlightTimes -----------------
        ch0_quality = self._determine_channel_quality(0, now)
        ch0 = self._raw_channels.get(0, [None] * 8)
        flight_times = FlightTimes(
            frame_rate_fps=ch0[0] if len(ch0) > 0 else None,
            total_time_sec=ch0[2] if len(ch0) > 2 else None,
            quality=ch0_quality,
            last_update=now_dt if ch0_quality == ChannelQuality.GOOD else None,
        )

        # Return snapshot
        return TelemetrySnapshot(
            timestamp=now_dt,
            status=status,
            speeds=speeds,
            attitude=attitude,
            position=position,
            dynamics=dynamics,
            controls=controls,
            engine=engine,
            flight_times=flight_times,
            raw_channels=dict(self._raw_channels),
        )
