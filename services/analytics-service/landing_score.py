"""
Landing Score Evaluator based on real touchdown physics.
Evaluates:
- Touchdown Vertical Speed (VVI, fpm)
- Vertical G-Force (Gz, g_load_normal)
- Centerline Offset (meters)
- Roll / Bank at touchdown (degrees)

STRICT ZERO-MOCK:
If no touchdown has occurred, returns {"status": "NO_TOUCHDOWN_YET"}.
If required telemetry fields are missing, explicitly reports error.
"""

from __future__ import annotations

import logging
import math
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger("landing_score")


class LandingScoreEvaluator:
    """
    Evaluates aircraft touchdown quality and calculates physical landing score (0 - 100).
    """

    def __init__(
        self,
        weight_vsi: float = 0.35,
        weight_gz: float = 0.35,
        weight_centerline: float = 0.20,
        weight_roll: float = 0.10,
        runway_threshold_lat: Optional[float] = None,
        runway_threshold_lon: Optional[float] = None,
        runway_heading_deg: Optional[float] = None,
    ) -> None:
        self.w_vsi = weight_vsi
        self.w_gz = weight_gz
        self.w_centerline = weight_centerline
        self.w_roll = weight_roll
        self.runway_threshold_lat = runway_threshold_lat
        self.runway_threshold_lon = runway_threshold_lon
        self.runway_heading_deg = runway_heading_deg

    def calculate_gps_cross_track_m(
        self, lat: float, lon: float, thresh_lat: float, thresh_lon: float, heading_deg: float
    ) -> float:
        """
        Calculates perpendicular distance (cross-track error) from runway centerline
        in meters using great-circle geometry.
        """
        r_earth = 6371000.0  # Earth radius in meters
        lat1 = math.radians(thresh_lat)
        lon1 = math.radians(thresh_lon)
        lat2 = math.radians(lat)
        lon2 = math.radians(lon)

        dlat = lat2 - lat1
        dlon = lon2 - lon1
        a = math.sin(dlat / 2.0) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2.0) ** 2
        d12 = 2.0 * math.atan2(math.sqrt(a), math.sqrt(1.0 - a))

        # Initial bearing from threshold to point
        y = math.sin(dlon) * math.cos(lat2)
        x = math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(dlon)
        brg = math.atan2(y, x)

        rwy_brg = math.radians(heading_deg)
        xtk_distance_rad = math.asin(math.sin(d12) * math.sin(brg - rwy_brg))
        return abs(xtk_distance_rad * r_earth)

    def evaluate_touchdown(self, touchdown_frame: Dict[str, Any]) -> Dict[str, Any]:
        """
        Evaluate landing score for a verified touchdown frame.

        :param touchdown_frame: Telemetry dictionary at touchdown moment.
        :return: Landing evaluation score breakdown or missing telemetry error.
        """
        missing: List[str] = []

        # 1. Vertical speed at touchdown
        vsi_raw = touchdown_frame.get("vertical_speed_fpm")
        vsi_eval: Dict[str, Any]
        score_vsi = 0.0
        if vsi_raw is None:
            vsi_eval = {"evaluated": False, "error": "MISSING_TELEMETRY: vertical_speed_fpm"}
            missing.append("vertical_speed_fpm")
        else:
            try:
                vsi = float(vsi_raw)
                score_vsi = self._calc_vsi_score(vsi)
                vsi_eval = {
                    "evaluated": True,
                    "touchdown_vsi_fpm": round(vsi, 1),
                    "score": round(score_vsi, 1),
                    "category": self._categorize_vsi(vsi),
                }
            except (ValueError, TypeError):
                vsi_eval = {"evaluated": False, "error": "MISSING_TELEMETRY: vertical_speed_fpm (invalid number)"}
                missing.append("vertical_speed_fpm")

        # 2. Vertical G-force (Gz) at touchdown
        gz_raw = touchdown_frame.get("g_load_normal")
        gz_eval: Dict[str, Any]
        score_gz = 0.0
        if gz_raw is None:
            gz_eval = {"evaluated": False, "error": "MISSING_TELEMETRY: g_load_normal"}
            missing.append("g_load_normal")
        else:
            try:
                gz = float(gz_raw)
                score_gz = self._calc_gz_score(gz)
                gz_eval = {
                    "evaluated": True,
                    "touchdown_g_load": round(gz, 3),
                    "score": round(score_gz, 1),
                    "category": self._categorize_gz(gz),
                }
            except (ValueError, TypeError):
                gz_eval = {"evaluated": False, "error": "MISSING_TELEMETRY: g_load_normal (invalid number)"}
                missing.append("g_load_normal")

        # 3. Centerline offset (meters)
        # Can be given directly as lateral_offset_m or centerline_offset_m,
        # or calculated from GPS if runway threshold is configured
        offset_raw = (
            touchdown_frame.get("centerline_offset_m")
            if touchdown_frame.get("centerline_offset_m") is not None
            else touchdown_frame.get("lateral_offset_m")
        )
        offset_eval: Dict[str, Any]
        score_offset = 0.0

        if offset_raw is None:
            # Check if GPS coordinates and runway parameters allow computation
            lat = touchdown_frame.get("latitude")
            lon = touchdown_frame.get("longitude")
            r_lat = touchdown_frame.get("runway_threshold_lat", self.runway_threshold_lat)
            r_lon = touchdown_frame.get("runway_threshold_lon", self.runway_threshold_lon)
            r_hdg = touchdown_frame.get("runway_heading_deg", self.runway_heading_deg)

            if lat is not None and lon is not None and r_lat is not None and r_lon is not None and r_hdg is not None:
                try:
                    computed_offset = self.calculate_gps_cross_track_m(
                        float(lat), float(lon), float(r_lat), float(r_lon), float(r_hdg)
                    )
                    score_offset = self._calc_centerline_score(computed_offset)
                    offset_eval = {
                        "evaluated": True,
                        "centerline_offset_m": round(computed_offset, 2),
                        "score": round(score_offset, 1),
                        "calculation_method": "GREAT_CIRCLE_CROSS_TRACK_GPS",
                    }
                except Exception:
                    offset_eval = {"evaluated": False, "error": "MISSING_TELEMETRY: centerline_offset_m"}
                    missing.append("centerline_offset_m")
            else:
                offset_eval = {"evaluated": False, "error": "MISSING_TELEMETRY: centerline_offset_m"}
                missing.append("centerline_offset_m")
        else:
            try:
                offset_m = abs(float(offset_raw))
                score_offset = self._calc_centerline_score(offset_m)
                offset_eval = {
                    "evaluated": True,
                    "centerline_offset_m": round(offset_m, 2),
                    "score": round(score_offset, 1),
                }
            except (ValueError, TypeError):
                offset_eval = {"evaluated": False, "error": "MISSING_TELEMETRY: centerline_offset_m (invalid number)"}
                missing.append("centerline_offset_m")

        # 4. Roll angle at touchdown
        roll_raw = touchdown_frame.get("roll_deg")
        roll_eval: Dict[str, Any]
        score_roll = 0.0
        if roll_raw is None:
            roll_eval = {"evaluated": False, "error": "MISSING_TELEMETRY: roll_deg"}
            missing.append("roll_deg")
        else:
            try:
                roll_deg = abs(float(roll_raw))
                score_roll = self._calc_roll_score(roll_deg)
                roll_eval = {
                    "evaluated": True,
                    "roll_at_touchdown_deg": round(roll_deg, 2),
                    "score": round(score_roll, 1),
                }
            except (ValueError, TypeError):
                roll_eval = {"evaluated": False, "error": "MISSING_TELEMETRY: roll_deg (invalid number)"}
                missing.append("roll_deg")

        # Handle missing fields
        if missing:
            return {
                "status": "ERROR_MISSING_DATA",
                "evaluated": False,
                "missing_telemetry": [f"MISSING_TELEMETRY: {m}" for m in missing],
                "breakdown": {
                    "vertical_speed": vsi_eval,
                    "vertical_g_force": gz_eval,
                    "centerline_offset": offset_eval,
                    "roll_angle": roll_eval,
                },
            }

        # Weighted composite score
        total_score = (
            (self.w_vsi * score_vsi)
            + (self.w_gz * score_gz)
            + (self.w_centerline * score_offset)
            + (self.w_roll * score_roll)
        )
        total_score = max(0.0, min(100.0, round(total_score, 1)))

        rating = self._categorize_overall_score(total_score)

        return {
            "status": "TOUCHDOWN_EVALUATED",
            "evaluated": True,
            "landing_score": total_score,
            "rating": rating,
            "touchdown_time_sec": touchdown_frame.get("time_sec"),
            "breakdown": {
                "vertical_speed": vsi_eval,
                "vertical_g_force": gz_eval,
                "centerline_offset": offset_eval,
                "roll_angle": roll_eval,
            },
        }

    def evaluate_frame(self, telemetry: Dict[str, Any]) -> Dict[str, Any]:
        """
        Evaluate landing score on a single telemetry frame.
        If on_runway == 0 or not on ground, returns NO_TOUCHDOWN_YET.
        """
        on_runway = telemetry.get("on_runway")
        if on_runway is None:
            return {
                "status": "ERROR_MISSING_DATA",
                "error": "MISSING_TELEMETRY: on_runway",
            }

        try:
            is_on_runway = int(on_runway) == 1
        except (ValueError, TypeError):
            return {
                "status": "ERROR_MISSING_DATA",
                "error": "MISSING_TELEMETRY: on_runway (invalid boolean/integer)",
            }

        if not is_on_runway:
            return {"status": "NO_TOUCHDOWN_YET"}

        return self.evaluate_touchdown(telemetry)

    def evaluate_flight_session(self, frames: List[Dict[str, Any]]) -> Dict[str, Any]:
        """
        Scan a flight recording session, locate the real touchdown event transition,
        and evaluate the touchdown metrics.
        """
        if not frames:
            return {"status": "NO_TOUCHDOWN_YET", "message": "Empty flight session provided"}

        touchdown_frame = None
        for i in range(1, len(frames)):
            curr_runway = frames[i].get("on_runway")
            prev_runway = frames[i - 1].get("on_runway")

            if curr_runway is not None and prev_runway is not None:
                try:
                    if int(curr_runway) == 1 and int(prev_runway) == 0:
                        touchdown_frame = frames[i]
                        break
                except (ValueError, TypeError):
                    continue

        # Fallback: find first frame where on_runway == 1 with altitude_agl <= 3.0
        if touchdown_frame is None:
            for frame in frames:
                if frame.get("on_runway") == 1 or frame.get("on_runway") == "1":
                    touchdown_frame = frame
                    break

        if touchdown_frame is None:
            return {"status": "NO_TOUCHDOWN_YET"}

        return self.evaluate_touchdown(touchdown_frame)

    @staticmethod
    def _calc_vsi_score(vsi: float) -> float:
        # Touchdown sink rate physics:
        # vsi is negative for descent (e.g. -120 fpm)
        mag = abs(vsi)
        if mag <= 160.0:
            if mag < 40.0:
                # Slight penalty for prolonged floating down runway
                return 88.0
            # Ideal butter touchdown (-40 to -160 fpm)
            return 100.0
        elif mag <= 280.0:
            # Positive, firm touchdown
            return 100.0 - ((mag - 160.0) / 120.0) * 15.0  # 100 -> 85
        elif mag <= 450.0:
            # Hard positive contact
            return 85.0 - ((mag - 280.0) / 170.0) * 35.0   # 85 -> 50
        elif mag <= 700.0:
            # Hard landing
            return 50.0 - ((mag - 450.0) / 250.0) * 35.0   # 50 -> 15
        else:
            # Structural damage risk (> 700 fpm)
            return max(0.0, 15.0 - ((mag - 700.0) / 200.0) * 15.0)

    @staticmethod
    def _calc_gz_score(gz: float) -> float:
        # Normal vertical load factor at touchdown
        if 1.0 <= gz <= 1.30:
            return 100.0
        elif gz < 1.0:
            # Sub-1G touchdown (balloon or stall drop)
            return max(50.0, 100.0 - (1.0 - gz) * 100.0)
        elif gz <= 1.60:
            return 100.0 - ((gz - 1.30) / 0.30) * 20.0     # 100 -> 80
        elif gz <= 2.00:
            return 80.0 - ((gz - 1.60) / 0.40) * 45.0      # 80 -> 35
        elif gz <= 2.50:
            return 35.0 - ((gz - 2.00) / 0.50) * 35.0      # 35 -> 0
        else:
            # > 2.50 G structural limit exceeded
            return 0.0

    @staticmethod
    def _calc_centerline_score(offset_m: float) -> float:
        if offset_m <= 1.5:
            return 100.0
        elif offset_m <= 4.0:
            return 100.0 - ((offset_m - 1.5) / 2.5) * 20.0  # 100 -> 80
        elif offset_m <= 8.0:
            return 80.0 - ((offset_m - 4.0) / 4.0) * 40.0   # 80 -> 40
        elif offset_m <= 15.0:
            return max(0.0, 40.0 - ((offset_m - 8.0) / 7.0) * 40.0)
        else:
            return 0.0

    @staticmethod
    def _calc_roll_score(roll_deg: float) -> float:
        if roll_deg <= 1.0:
            return 100.0
        elif roll_deg <= 3.0:
            return 85.0
        elif roll_deg <= 5.0:
            return 60.0
        elif roll_deg <= 7.0:
            return 30.0
        else:
            return 0.0

    @staticmethod
    def _categorize_vsi(vsi: float) -> str:
        mag = abs(vsi)
        if mag <= 160.0:
            return "BUTTER_SMOOTH"
        elif mag <= 280.0:
            return "NORMAL_TOUCHDOWN"
        elif mag <= 450.0:
            return "FIRM_TOUCHDOWN"
        elif mag <= 700.0:
            return "HARD_LANDING"
        else:
            return "SEVERE_HARD_LANDING"

    @staticmethod
    def _categorize_gz(gz: float) -> str:
        if gz <= 1.30:
            return "NORMAL_LOAD"
        elif gz <= 1.60:
            return "MODERATE_LOAD"
        elif gz <= 2.00:
            return "HEAVY_IMPACT"
        else:
            return "STRUCTURAL_OVERLOAD"

    @staticmethod
    def _categorize_overall_score(score: float) -> str:
        if score >= 90.0:
            return "BUTTER / EXCELLENT"
        elif score >= 80.0:
            return "GOOD"
        elif score >= 65.0:
            return "ACCEPTABLE / FIRM"
        elif score >= 45.0:
            return "HARD LANDING"
        else:
            return "UNSATISFACTORY / DANGEROUS"
