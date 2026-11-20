"""
Comprehensive unit tests for Analytics Service:
- ICAO DOC 8168 & FAA AC 120-108 Stabilized Approach rules
- Landing Score Physics & Touchdown detection
- Warnings generator (SINK RATE, PULL UP, GLIDESLOPE UNSTABLE, TOO HIGH SPEED, BANK ANGLE)
- Zero-mock policy & missing telemetry error verification
"""

import csv
import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from stabilized_approach import StabilizedApproachMonitor
from landing_score import LandingScoreEvaluator

from ai_warnings import FlightWarningsGenerator
from flight_phase import FlightPhaseTracker, FlightPhase, find_touchdowns


class TestStabilizedApproach(unittest.TestCase):

    def setUp(self):
        self.monitor = StabilizedApproachMonitor(default_target_ias_kt=65.0)

    def test_missing_telemetry_fields(self):
        """Missing fields must yield evaluated=False and explicit MISSING_TELEMETRY error."""
        res = self.monitor.evaluate_frame({})
        self.assertFalse(res["evaluated"])
        self.assertEqual(res["status"], "UNABLE_TO_EVALUATE_MISSING_DATA")
        self.assertIn("MISSING_TELEMETRY: altitude_agl_ft", res["missing_telemetry"])
        self.assertIn("MISSING_TELEMETRY: vertical_speed_fpm", res["missing_telemetry"])
        self.assertIn("MISSING_TELEMETRY: indicated_airspeed_kt", res["missing_telemetry"])
        self.assertIn("MISSING_TELEMETRY: flap_ratio", res["missing_telemetry"])
        self.assertIn("MISSING_TELEMETRY: gear_ratio", res["missing_telemetry"])
        self.assertIn("MISSING_TELEMETRY: roll_deg", res["missing_telemetry"])

    def test_stabilized_approach_pass(self):
        """Standard stabilized approach criteria below 1000 ft AGL."""
        frame = {
            "altitude_agl_ft": 450.0,
            "vertical_speed_fpm": -650.0,
            "indicated_airspeed_kt": 66.0,
            "flap_ratio": 1.0,
            "gear_ratio": 1.0,
            "roll_deg": 1.5,
        }
        res = self.monitor.evaluate_frame(frame)
        self.assertTrue(res["evaluated"])
        self.assertTrue(res["is_stabilized"])
        self.assertEqual(res["status"], "STABILIZED")
        self.assertEqual(len(res["failed_rules"]), 0)

    def test_excessive_sink_rate_fail(self):
        """Sink rate > 1000 fpm below 1000 ft AGL must fail."""
        frame = {
            "altitude_agl_ft": 450.0,
            "vertical_speed_fpm": -1250.0,  # Fails DOC 8168 limit
            "indicated_airspeed_kt": 65.0,
            "flap_ratio": 1.0,
            "gear_ratio": 1.0,
            "roll_deg": 1.0,
        }
        res = self.monitor.evaluate_frame(frame)
        self.assertTrue(res["evaluated"])
        self.assertFalse(res["is_stabilized"])
        self.assertIn("sink_rate", res["failed_rules"])

    def test_speed_deviation_fail(self):
        """Speed outside [-5, +10] kt from target must fail."""
        frame = {
            "altitude_agl_ft": 450.0,
            "vertical_speed_fpm": -600.0,
            "indicated_airspeed_kt": 85.0,  # Target is 65 -> +20 kt (fails)
            "flap_ratio": 1.0,
            "gear_ratio": 1.0,
            "roll_deg": 1.0,
        }
        res = self.monitor.evaluate_frame(frame)
        self.assertTrue(res["evaluated"])
        self.assertFalse(res["is_stabilized"])
        self.assertIn("airspeed", res["failed_rules"])

    def test_excessive_bank_fail(self):
        """Roll > 7 deg on final approach must fail."""
        frame = {
            "altitude_agl_ft": 300.0,
            "vertical_speed_fpm": -600.0,
            "indicated_airspeed_kt": 65.0,
            "flap_ratio": 1.0,
            "gear_ratio": 1.0,
            "roll_deg": 8.5,  # Exceeds 7 deg limit
        }
        res = self.monitor.evaluate_frame(frame)
        self.assertTrue(res["evaluated"])
        self.assertFalse(res["is_stabilized"])
        self.assertIn("bank_angle", res["failed_rules"])


class TestLandingScore(unittest.TestCase):

    def setUp(self):
        self.evaluator = LandingScoreEvaluator()

    def test_no_touchdown_when_airborne(self):
        """When on_runway == 0, must return NO_TOUCHDOWN_YET."""
        airborne_frame = {
            "on_runway": 0,
            "altitude_agl_ft": 500.0,
            "vertical_speed_fpm": -600.0,
        }
        res = self.evaluator.evaluate_frame(airborne_frame)
        self.assertEqual(res["status"], "NO_TOUCHDOWN_YET")

    def test_touchdown_score_physics(self):
        """Greaser touchdown with excellent parameters should score ~95-100."""
        touchdown_frame = {
            "on_runway": 1,
            "vertical_speed_fpm": -110.0,
            "g_load_normal": 1.15,
            "centerline_offset_m": 0.8,
            "roll_deg": 0.3,
            "time_sec": 120.5,
        }
        res = self.evaluator.evaluate_frame(touchdown_frame)
        self.assertEqual(res["status"], "TOUCHDOWN_EVALUATED")
        self.assertTrue(res["evaluated"])
        self.assertGreaterEqual(res["landing_score"], 95.0)

    def test_hard_landing_physics(self):
        """Hard landing (-750 fpm, 2.2G, 6m off centerline) should score low."""
        hard_touchdown = {
            "on_runway": 1,
            "vertical_speed_fpm": -750.0,
            "g_load_normal": 2.2,
            "centerline_offset_m": 6.5,
            "roll_deg": 4.5,
        }
        res = self.evaluator.evaluate_frame(hard_touchdown)
        self.assertEqual(res["status"], "TOUCHDOWN_EVALUATED")
        self.assertLess(res["landing_score"], 50.0)


class TestWarningsGenerator(unittest.TestCase):

    def setUp(self):
        self.generator = FlightWarningsGenerator()

    def test_sink_rate_and_pull_up_warnings(self):
        """High sink rate near ground triggers SINK RATE and PULL UP."""
        telemetry = {
            "altitude_agl_ft": 250.0,
            "vertical_speed_fpm": -1600.0,
            "indicated_airspeed_kt": 75.0,
            "groundspeed_kt": 70.0,
            "roll_deg": 1.0,
            "on_runway": 0,
        }
        res = self.generator.evaluate_warnings(telemetry)
        self.assertIn("SINK RATE", res["active_warnings"])
        self.assertIn("PULL UP", res["active_warnings"])

    def test_too_high_speed_with_flaps(self):
        """Speed exceeding Vfe placard triggers TOO HIGH SPEED."""
        telemetry = {
            "altitude_agl_ft": 400.0,
            "vertical_speed_fpm": -500.0,
            "indicated_airspeed_kt": 115.0,  # Exceeds 110 kt Vfe
            "groundspeed_kt": 110.0,
            "flap_ratio": 1.0,
            "roll_deg": 1.0,
            "on_runway": 0,
        }
        res = self.generator.evaluate_warnings(telemetry)
        self.assertIn("TOO HIGH SPEED", res["active_warnings"])


DATA_CSV = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", "data", "telemetry_essential.csv"))


def _load_rows():
    with open(DATA_CSV, encoding="utf-8") as f:
        return list(csv.DictReader(f))


class TestFlightPhaseAndTouchdown(unittest.TestCase):

    def test_touchdowns_in_recorded_ukll_flight(self):
        """Two circuits in the recording: contacts at ~113.3 s and ~208.6 s, not at 51.5 s (61 ft over the runway)."""
        events = find_touchdowns(_load_rows())
        self.assertEqual(len(events), 2)
        self.assertAlmostEqual(events[0].time_sec, 113.3, delta=0.5)
        self.assertAlmostEqual(events[1].time_sec, 208.6, delta=0.5)
        first = events[0]
        self.assertLess(float(first.contact_frame["altitude_agl_ft"]), 1.5)
        self.assertLess(first.min_vsi_fpm, -150.0)
        self.assertGreater(first.peak_g, 1.5)

    def test_no_touchdown_while_parked_or_on_takeoff_roll(self):
        tracker = FlightPhaseTracker()
        for row in _load_rows():
            state = tracker.update(row)
            if float(row["time_sec"]) > 60.0:
                break
            self.assertIsNone(state.touchdown, f"false touchdown at t={row['time_sec']}")

    def test_replay_restart_resets_state(self):
        tracker = FlightPhaseTracker()
        rows = _load_rows()
        for row in rows:
            tracker.update(row)
        self.assertIsNotNone(tracker.last_touchdown)
        state = tracker.update(rows[0])  # time jumps back to 0
        self.assertIsNone(state.touchdown)
        self.assertEqual(state.phase, FlightPhase.GROUND)


class TestAnalyticsServer(unittest.TestCase):

    def setUp(self):
        from fastapi.testclient import TestClient
        import server
        self.client = TestClient(server.app)

    def test_stream_does_not_score_or_flag_on_ground(self):
        rows = _load_rows()
        with self.client.websocket_connect("/ws/analytics") as ws:
            for row in rows[:200]:  # parked and taxi, all on the ground
                ws.send_json(row)
                res = ws.receive_json()
                self.assertEqual(res["landing_score"]["status"], "NO_TOUCHDOWN_YET")
                self.assertEqual(res["stabilized_approach"]["status"], "NOT_ON_APPROACH")
                self.assertEqual(res["warnings"]["active_warnings"], [])

    def test_stream_reports_touchdown_once_window_closes(self):
        rows = [r for r in _load_rows() if float(r["time_sec"]) <= 116.0]
        last = None
        with self.client.websocket_connect("/ws/analytics") as ws:
            for row in rows:
                ws.send_json(row)
                last = ws.receive_json()
        self.assertEqual(last["landing_score"]["status"], "TOUCHDOWN_EVALUATED")
        self.assertEqual(last["landing_score"]["touchdown_id"], 1)

    def test_session_uses_real_touchdowns(self):
        resp = self.client.post("/analytics/session", json={"csv_file_path": "telemetry_essential.csv"})
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertEqual(len(body["touchdowns"]), 2)
        self.assertIsInstance(body["landing_score"]["touchdown_time_sec"], float)

    def test_session_rejects_path_traversal(self):
        resp = self.client.post("/analytics/session", json={"csv_file_path": "../../../../etc/passwd"})
        self.assertEqual(resp.status_code, 400)


if __name__ == "__main__":
    unittest.main()
