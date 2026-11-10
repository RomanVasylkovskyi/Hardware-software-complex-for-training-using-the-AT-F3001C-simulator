"""
Unit and integration tests for Gateway Service.
Validates:
- Unified payload formatting under offline / disconnect conditions (no stubs, explicit nulls).
- Telemetry normalization preserving real data and null fields.
- Static file resolution for the Instructor Panel.
"""

import sys
import os
import unittest
from pathlib import Path

# Add src to path
current_dir = Path(__file__).resolve().parent
src_dir = current_dir.parent / "src"
sys.path.insert(0, str(src_dir))

from config import Settings
from aggregator import StreamAggregator, normalize_telemetry


class TestGatewayService(unittest.TestCase):
    def setUp(self):
        self.settings = Settings(
            HOST="0.0.0.0",
            PORT=8000,
            BROADCAST_RATE_HZ=25.0,
            STATIC_DIR="",
        )
        self.aggregator = StreamAggregator(self.settings)

    def test_offline_payload_enforces_nulls_and_explicit_status(self):
        """CRITICAL: If backend services are offline, payload must report nulls, NEVER fake data."""
        payload = self.aggregator.get_unified_payload()

        self.assertEqual(payload["service_status"]["telemetry"], "OFFLINE")
        self.assertEqual(payload["service_status"]["vision"], "OFFLINE")
        self.assertEqual(payload["service_status"]["analytics"], "OFFLINE")

        # Telemetry, vision, and analytics MUST BE null
        self.assertIsNone(payload["telemetry"])
        self.assertIsNone(payload["vision"])
        self.assertIsNone(payload["analytics"])

        self.assertEqual(payload["broadcast_rate_hz"], 25.0)
        self.assertEqual(payload["airport_icao"], "UKLL")
        self.assertEqual(payload["runway_ident"], "13")

    def test_telemetry_normalization_flat(self):
        """Flat telemetry dictionary is preserved without modification."""
        raw = {
            "time_sec": 10.5,
            "latitude": 49.81482,
            "longitude": 23.9545,
            "altitude_msl_ft": 1043.28,
            "indicated_airspeed_kt": 90.92,
            "pitch_deg": 1.2,
            "roll_deg": -2.4,
            "rpm": None, # Sensor unread
        }
        normalized = normalize_telemetry(raw)
        self.assertEqual(normalized["latitude"], 49.81482)
        self.assertEqual(normalized["indicated_airspeed_kt"], 90.92)
        self.assertEqual(normalized["pitch_deg"], 1.2)
        # Unread sensor remains strictly None
        self.assertIsNone(normalized["rpm"])

    def test_telemetry_normalization_nested_snapshot(self):
        """Nested TelemetrySnapshot from telemetry-service is flattened for UI while preserving nested fields."""
        raw_snapshot = {
            "timestamp": "2026-11-10T16:55:00Z",
            "speeds": {
                "indicated_airspeed_kt": 95.0,
                "true_airspeed_kt": 98.0,
                "groundspeed_kt": 96.5,
            },
            "attitude": {
                "pitch_deg": 3.5,
                "roll_deg": 0.5,
                "heading_true_deg": 135.8,
                "heading_mag_deg": 131.2,
            },
            "position": {
                "latitude": 49.82026,
                "longitude": 23.94254,
                "altitude_msl_ft": 1064.0,
                "altitude_agl_ft": 12.5,
                "on_runway": False,
            },
            "dynamics": {
                "vertical_speed_fpm": 450.0,
                "g_load_normal": 1.08,
            },
            "controls": {
                "elevator": -0.15,
                "flap_ratio": 0.33,
            },
            "engine": {
                "rpm": 2450.0,
                "oil_pressure_psi": 65.0,
                "oil_temp_degc": 78.0,
                "fuel_flow_pph": 54.0,
            },
            "flight_times": {
                "total_time_sec": 42.5,
            }
        }
        norm = normalize_telemetry(raw_snapshot)

        # Both flat and nested keys should be available
        self.assertEqual(norm["indicated_airspeed_kt"], 95.0)
        self.assertEqual(norm["pitch_deg"], 3.5)
        self.assertEqual(norm["latitude"], 49.82026)
        self.assertEqual(norm["vertical_speed_fpm"], 450.0)
        self.assertEqual(norm["elevator_stick"], -0.15)
        self.assertEqual(norm["rpm"], 2450.0)
        self.assertEqual(norm["oil_press_psi"], 65.0)
        self.assertEqual(norm["oil_temp_c"], 78.0)
        self.assertEqual(norm["fuel_flow_gph"], 9.0) # 54 / 6.0
        self.assertEqual(norm["time_sec"], 42.5)

        # Original nested dicts remain accessible
        self.assertIn("speeds", norm)
        self.assertEqual(norm["speeds"]["indicated_airspeed_kt"], 95.0)

    def test_static_directory_resolution(self):
        """Verify the static directory points to instructor-panel and files exist."""
        static_dir = self.settings.resolve_static_dir()
        self.assertTrue(static_dir.exists(), f"Static dir {static_dir} must exist")
        index_file = static_dir / "index.html"
        self.assertTrue(index_file.exists(), f"index.html must exist at {index_file}")

    def test_fastapi_endpoints_and_static_client(self):
        """Verify FastAPI REST and static file serving using TestClient."""
        from fastapi.testclient import TestClient
        from main import app

        with TestClient(app) as client:
            # 1. Health endpoint
            r_health = client.get("/health")
            self.assertEqual(r_health.status_code, 200)
            data = r_health.json()
            self.assertEqual(data["status"], "ok")
            self.assertEqual(data["service_status"]["telemetry"], "OFFLINE")

            # 2. API Status endpoint
            r_status = client.get("/api/status")
            self.assertEqual(r_status.status_code, 200)

            # 3. API Telemetry snapshot endpoint
            r_telem = client.get("/api/telemetry")
            self.assertEqual(r_telem.status_code, 200)
            self.assertIsNone(r_telem.json()["telemetry"])

            # 4. Static instructor-panel index.html
            r_index = client.get("/")
            self.assertEqual(r_index.status_code, 200)
            self.assertIn("AT-F3001C", r_index.text)
            self.assertIn("Primary Flight Display", r_index.text)
            self.assertIn("pfd-canvas", r_index.text)



if __name__ == "__main__":
    unittest.main()
