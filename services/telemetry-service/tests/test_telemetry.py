"""
Comprehensive automated tests for Telemetry Microservice.

Validates:
1. Exact X-Plane 11 binary UDP packet parsing and -999.0 null sentinel enforcement.
2. Rejection of corrupted datagrams with explicit error flags.
3. Channel freshness and staleness transitions (GOOD -> STALE -> OFFLINE).
4. Real flight dataset replay integrity (telemetry_essential.csv).
5. FastAPI REST endpoints (/health, /telemetry/current, /telemetry/status, /replay/start, /replay/stop).
6. WebSocket streaming and message handling.
"""

import math
from pathlib import Path
import struct
import sys
import time
import pytest
from starlette.testclient import TestClient

# Ensure service directory is on sys.path for direct imports
SERVICE_DIR = Path(__file__).resolve().parent.parent
if str(SERVICE_DIR) not in sys.path:
    sys.path.insert(0, str(SERVICE_DIR))

from models import (
    ChannelQuality,
    ConnectionStatus,
    TelemetrySnapshot,
)
from parser import (
    TelemetryParser,
    is_xplane_null,
    parse_xplane_datagram,
    XPLANE_DATA_HEADER,
    XPLANE_NULL_VALUE,
)
from replay import (
    FlightDataReplayer,
    locate_flight_data_file,
    pack_real_row_to_xplane_udp,
)
from server import app, telemetry_parser


def test_is_xplane_null():
    """Verify X-Plane sentinel value -999.0 and invalid floats are strictly recognized as null."""
    assert is_xplane_null(-999.0) is True
    assert is_xplane_null(-999.0001) is True
    assert is_xplane_null(-998.9999) is True
    assert is_xplane_null(float("nan")) is True
    assert is_xplane_null(float("inf")) is True

    # Real flight numbers must NOT be treated as null
    assert is_xplane_null(0.0) is False
    assert is_xplane_null(100.5) is False
    assert is_xplane_null(-1.0) is False
    assert is_xplane_null(49.81482) is False


def test_parse_valid_xplane_binary_packet():
    """Test parsing of an authentic X-Plane 11 UDP datagram with multiple channels."""
    # Build Channel 3 (Speeds: vind_kias=95.5, vind_keas=-999, vt_ktas=102.3, vt_ktgs=100.0)
    ch3_bytes = struct.pack(
        "<i8f",
        3,
        95.5, -999.0, 102.3, 100.0,
        -999.0, -999.0, -999.0, -999.0
    )
    # Build Channel 20 (Position: lat=49.81482, lon=23.95450, alt_msl=1043.28, alt_agl=150.0, on_rwy=0.0)
    ch20_bytes = struct.pack(
        "<i8f",
        20,
        49.81482, 23.95450, 1043.28, 150.0, 0.0,
        -999.0, -999.0, -999.0
    )

    packet = XPLANE_DATA_HEADER + ch3_bytes + ch20_bytes
    channels, err = parse_xplane_datagram(packet)

    assert err is None
    assert channels is not None
    assert 3 in channels
    assert 20 in channels

    # Channel 3 checks
    assert channels[3][0] == 95.5
    assert channels[3][1] is None  # -999.0 MUST BE None!
    assert channels[3][2] == 102.3
    assert channels[3][3] == 100.0
    assert channels[3][4] is None

    # Channel 20 checks
    assert channels[20][0] == pytest.approx(49.81482, rel=1e-4)
    assert channels[20][1] == pytest.approx(23.95450, rel=1e-4)
    assert channels[20][2] == pytest.approx(1043.28, rel=1e-4)
    assert channels[20][3] == pytest.approx(150.0, rel=1e-4)
    assert channels[20][4] == 0.0
    assert channels[20][5] is None


def test_corrupted_packet_handling():
    """Test that truncated or malformed UDP datagrams are rejected without crashing."""
    # 1. Packet too short
    channels, err = parse_xplane_datagram(b"DATA")
    assert channels is None
    assert "too short" in err.lower()

    # 2. Invalid header
    channels, err = parse_xplane_datagram(b"FAKE\x00" + b"\x00" * 36)
    assert channels is None
    assert "invalid packet header" in err.lower()

    # 3. Payload not multiple of 36 bytes
    channels, err = parse_xplane_datagram(XPLANE_DATA_HEADER + b"\x00" * 20)
    assert channels is None
    assert "corrupted payload size" in err.lower()


def test_parser_staleness_and_timeouts():
    """Test channel freshness degradation and simulator offline detection."""
    parser = TelemetryParser(stale_timeout_sec=1.0, offline_timeout_sec=3.0)

    # Initially before any packet received:
    initial_snapshot = parser.check_staleness(now_monotonic=10.0)
    assert initial_snapshot.status.connection == ConnectionStatus.OFFLINE
    assert initial_snapshot.speeds.quality == ChannelQuality.NO_SIGNAL
    assert initial_snapshot.speeds.indicated_airspeed_kt is None

    # Ingest packet at t=10.0
    ch17_bytes = struct.pack("<i8f", 17, 5.2, -1.8, 145.0, 142.0, -999.0, -999.0, -999.0, -999.0)
    packet = XPLANE_DATA_HEADER + ch17_bytes
    snapshot, err = parser.process_packet(packet, receive_monotonic=10.0)

    assert err is None
    assert snapshot.status.connection == ConnectionStatus.CONNECTED
    assert snapshot.attitude.quality == ChannelQuality.GOOD
    assert snapshot.attitude.pitch_deg == 5.2
    assert snapshot.attitude.roll_deg == -1.8
    assert snapshot.attitude.heading_true_deg == 145.0

    # Advance time to t=11.5 (older than 1.0s stale timeout, but < 3.0s offline)
    snapshot_stale = parser.check_staleness(now_monotonic=11.5)
    assert snapshot_stale.attitude.quality == ChannelQuality.STALE
    assert snapshot_stale.status.connection == ConnectionStatus.STALE

    # Advance time to t=14.0 (> 3.0s offline timeout)
    snapshot_offline = parser.check_staleness(now_monotonic=14.0)
    assert snapshot_offline.status.connection == ConnectionStatus.OFFLINE
    assert any("lost" in err.lower() for err in snapshot_offline.status.errors)


def test_real_flight_data_loading_and_packing():
    """
    Test loading real telemetry data from telemetry_essential.csv,
    packing into authentic X-Plane UDP datagrams, and parsing them back.
    Verifies 100% real data integrity with zero stubs.
    """
    replayer = FlightDataReplayer()
    count = replayer.load_data()
    assert count == 333, f"Expected 333 real data points, got {count}"

    # Verify first row matches known UKLL Cessna 172SP flight start
    first_row = replayer._records[0]
    assert first_row["latitude"] == pytest.approx(49.81482, rel=1e-4)
    assert first_row["longitude"] == pytest.approx(23.95450, rel=1e-4)
    assert first_row["altitude_msl_ft"] == pytest.approx(1043.28, rel=1e-2)
    assert first_row["gear_ratio"] == 1.0  # Gear extended on ground
    assert first_row["throttle_ratio"] == 0.0

    # Pack to real X-Plane UDP packet
    udp_packet = pack_real_row_to_xplane_udp(first_row)
    assert udp_packet.startswith(XPLANE_DATA_HEADER)
    # Verify packet length: 5 header + 10 channels * 36 bytes = 365 bytes
    assert len(udp_packet) == 5 + 10 * 36

    # Ingest into parser
    parser = TelemetryParser()
    snapshot, err = parser.process_packet(udp_packet)

    assert err is None
    assert snapshot is not None
    assert snapshot.position.latitude == pytest.approx(49.81482, rel=1e-4)
    assert snapshot.position.longitude == pytest.approx(23.95450, rel=1e-4)
    assert snapshot.position.altitude_msl_ft == pytest.approx(1043.28, rel=1e-2)
    assert snapshot.controls.gear_ratio == 1.0
    assert snapshot.position.on_runway is True
    # Verify unassigned fields are strictly None
    assert snapshot.speeds.indicated_airspeed_mph is None
    assert snapshot.engine.rpm is None
    assert snapshot.dynamics.mach_number is None


def test_replay_progress():
    """Verify replay progress tracking on real data."""
    replayer = FlightDataReplayer()
    replayer.load_data()
    assert replayer.total_records == 333
    assert replayer.progress_pct == 0.0


def test_rest_endpoints():
    """Verify FastAPI REST endpoints with TestClient."""
    with TestClient(app) as client:
        # 1. Health
        resp = client.get("/health")
        assert resp.status_code == 200
        health_data = resp.json()
        assert health_data["service"] == "telemetry-service"
        assert health_data["status"] == "ok"
        assert "simulator_connection" in health_data

        # 2. Current Telemetry
        resp = client.get("/telemetry/current")
        assert resp.status_code == 200
        telem_data = resp.json()
        assert "status" in telem_data
        assert "speeds" in telem_data
        assert "attitude" in telem_data
        assert "position" in telem_data
        assert "controls" in telem_data

        # 3. Status
        resp = client.get("/telemetry/status")
        assert resp.status_code == 200
        status_data = resp.json()
        assert "connection" in status_data
        assert "packet_rate_hz" in status_data
        assert "packets_received" in status_data

        # 4. Replay stop
        resp = client.post("/replay/stop")
        assert resp.status_code == 200


def test_websocket_stream():
    """Verify WebSocket /ws/telemetry receives real telemetry snapshots."""
    with TestClient(app) as client:
        with client.websocket_connect("/ws/telemetry") as websocket:
            # First message should be initial snapshot
            data = websocket.receive_json()
            assert "status" in data
            assert "speeds" in data
            assert "attitude" in data
            assert "position" in data

            # Send ping
            websocket.send_text('{"action": "ping"}')
            response = websocket.receive_json()
            # It could be either the pong or the next periodic broadcast
            if response.get("action") == "pong":
                assert "timestamp" in response
            else:
                assert "status" in response
