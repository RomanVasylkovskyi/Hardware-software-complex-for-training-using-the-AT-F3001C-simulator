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

try:
    from ai_warnings import FlightWarningsGenerator
except ImportError:
    from warnings import FlightWarningsGenerator


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


if __name__ == "__main__":
    unittest.main()
