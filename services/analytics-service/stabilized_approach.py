"""
Stabilized Approach Monitor according to ICAO DOC 8168 and FAA AC 120-108.
Evaluates final approach stability gates (1000 ft IMC and 500 ft VMC):
- Sink rate: VVI <= 1000 fpm below 1000 ft AGL
- Speed: Target IAS within [-5, +10] kt
- Configuration: Flaps extended in landing config, Gear down
- Bank angle: Roll <= 7 deg on final approach
STRICT ZERO-MOCK: If any telemetry field is None or missing, returns
{"evaluated": false, "error": "MISSING_TELEMETRY: <field>"}.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

logger = logging.getLogger("stabilized_approach")


class StabilizedApproachMonitor:
    """
    Evaluator for aircraft approach stabilization according to ICAO DOC 8168 and FAA AC 120-108.
    """

    def __init__(
        self,
        default_target_ias_kt: float = 65.0,
        max_sink_rate_fpm: float = 1000.0,
        speed_margin_minus_kt: float = 5.0,
        speed_margin_plus_kt: float = 10.0,
        max_roll_deg: float = 7.0,
        min_flap_ratio: float = 0.5,
    ) -> None:
        self.default_target_ias_kt = default_target_ias_kt
        self.max_sink_rate_fpm = max_sink_rate_fpm
        self.speed_margin_minus_kt = speed_margin_minus_kt
        self.speed_margin_plus_kt = speed_margin_plus_kt
        self.max_roll_deg = max_roll_deg
        self.min_flap_ratio = min_flap_ratio

    def evaluate_frame(
        self,
        telemetry: Dict[str, Any],
        target_ias_kt: Optional[float] = None,
        is_vmc: bool = False,
    ) -> Dict[str, Any]:
        """
        Evaluate single flight telemetry frame against ICAO/FAA stabilization rules.

        :param telemetry: Dictionary containing current telemetry sample.
        :param target_ias_kt: Target approach speed (defaults to 65 kt for C172).
        :param is_vmc: If True, stabilization gate is 500 ft AGL; if False (IMC), gate is 1000 ft AGL.
        :return: Evaluation result dictionary.
        """
        target_speed = target_ias_kt or telemetry.get("target_ias_kt") or self.default_target_ias_kt

        rules: Dict[str, Dict[str, Any]] = {}
        missing_fields: List[str] = []
        failed_rules: List[str] = []

        # 1. Altitude check
        alt_agl = telemetry.get("altitude_agl_ft")
        if alt_agl is None:
            rules["altitude_agl"] = {
                "evaluated": False,
                "error": "MISSING_TELEMETRY: altitude_agl_ft",
            }
            missing_fields.append("altitude_agl_ft")
        else:
            try:
                alt_agl = float(alt_agl)
            except (ValueError, TypeError):
                rules["altitude_agl"] = {
                    "evaluated": False,
                    "error": "MISSING_TELEMETRY: altitude_agl_ft (invalid number)",
                }
                missing_fields.append("altitude_agl_ft")
                alt_agl = None

        gate_altitude = 500.0 if is_vmc else 1000.0
        gate_name = "500FT_VMC" if is_vmc else "1000FT_IMC"

        # Check if aircraft is currently below the stabilization gate
        is_below_gate = alt_agl is not None and alt_agl <= gate_altitude

        # 2. Rule: Sink Rate (VVI <= 1000 fpm below 1000 ft AGL)
        vsi = telemetry.get("vertical_speed_fpm")
        if vsi is None:
            rules["sink_rate"] = {
                "evaluated": False,
                "error": "MISSING_TELEMETRY: vertical_speed_fpm",
            }
            missing_fields.append("vertical_speed_fpm")
        elif alt_agl is None:
            rules["sink_rate"] = {
                "evaluated": False,
                "error": "MISSING_TELEMETRY: altitude_agl_ft",
            }
        else:
            try:
                vsi_val = float(vsi)
                # In aviation telemetry, descent is negative VSI (e.g. -700 fpm).
                # Rate of descent magnitude should not exceed max_sink_rate_fpm (1000 fpm).
                sink_rate_magnitude = -vsi_val if vsi_val < 0 else 0.0

                if not is_below_gate:
                    rules["sink_rate"] = {
                        "evaluated": True,
                        "pass": True,
                        "status": "ABOVE_GATE",
                        "actual_vsi_fpm": vsi_val,
                        "gate_altitude_ft": gate_altitude,
                    }
                else:
                    passed = sink_rate_magnitude <= self.max_sink_rate_fpm
                    rules["sink_rate"] = {
                        "evaluated": True,
                        "pass": passed,
                        "actual_vsi_fpm": vsi_val,
                        "sink_rate_fpm": round(sink_rate_magnitude, 1),
                        "max_allowed_fpm": self.max_sink_rate_fpm,
                        "error": None if passed else f"EXCESSIVE_SINK_RATE: {sink_rate_magnitude:.1f} fpm exceeds {self.max_sink_rate_fpm} fpm below {gate_altitude} ft",
                    }
                    if not passed:
                        failed_rules.append("sink_rate")
            except (ValueError, TypeError):
                rules["sink_rate"] = {
                    "evaluated": False,
                    "error": "MISSING_TELEMETRY: vertical_speed_fpm (invalid number)",
                }
                missing_fields.append("vertical_speed_fpm")

        # 3. Rule: Speed (Target IAS +/- 5-10 kt)
        ias = telemetry.get("indicated_airspeed_kt")
        if ias is None:
            rules["airspeed"] = {
                "evaluated": False,
                "error": "MISSING_TELEMETRY: indicated_airspeed_kt",
            }
            missing_fields.append("indicated_airspeed_kt")
        else:
            try:
                ias_val = float(ias)
                min_speed = target_speed - self.speed_margin_minus_kt
                max_speed = target_speed + self.speed_margin_plus_kt

                if not is_below_gate:
                    rules["airspeed"] = {
                        "evaluated": True,
                        "pass": True,
                        "status": "ABOVE_GATE",
                        "actual_ias_kt": ias_val,
                    }
                else:
                    passed = min_speed <= ias_val <= max_speed
                    rules["airspeed"] = {
                        "evaluated": True,
                        "pass": passed,
                        "actual_ias_kt": round(ias_val, 1),
                        "target_ias_kt": round(target_speed, 1),
                        "min_allowed_kt": round(min_speed, 1),
                        "max_allowed_kt": round(max_speed, 1),
                        "error": None if passed else f"SPEED_DEVIATION: {ias_val:.1f} kt outside allowed range [{min_speed:.1f}, {max_speed:.1f}] kt",
                    }
                    if not passed:
                        failed_rules.append("airspeed")
            except (ValueError, TypeError):
                rules["airspeed"] = {
                    "evaluated": False,
                    "error": "MISSING_TELEMETRY: indicated_airspeed_kt (invalid number)",
                }
                missing_fields.append("indicated_airspeed_kt")

        # 4. Rule: Flaps Configuration
        flaps = telemetry.get("flap_ratio")
        if flaps is None:
            rules["flaps"] = {
                "evaluated": False,
                "error": "MISSING_TELEMETRY: flap_ratio",
            }
            missing_fields.append("flap_ratio")
        else:
            try:
                flaps_val = float(flaps)
                if not is_below_gate:
                    rules["flaps"] = {
                        "evaluated": True,
                        "pass": True,
                        "status": "ABOVE_GATE",
                        "actual_flap_ratio": flaps_val,
                    }
                else:
                    passed = flaps_val >= self.min_flap_ratio
                    rules["flaps"] = {
                        "evaluated": True,
                        "pass": passed,
                        "actual_flap_ratio": round(flaps_val, 2),
                        "required_min_flap_ratio": self.min_flap_ratio,
                        "error": None if passed else f"FLAPS_NOT_CONFIGURED: flap_ratio is {flaps_val:.2f}, required >= {self.min_flap_ratio:.2f}",
                    }
                    if not passed:
                        failed_rules.append("flaps")
            except (ValueError, TypeError):
                rules["flaps"] = {
                    "evaluated": False,
                    "error": "MISSING_TELEMETRY: flap_ratio (invalid number)",
                }
                missing_fields.append("flap_ratio")

        # 5. Rule: Landing Gear Configuration
        gear = telemetry.get("gear_ratio")
        if gear is None:
            rules["landing_gear"] = {
                "evaluated": False,
                "error": "MISSING_TELEMETRY: gear_ratio",
            }
            missing_fields.append("gear_ratio")
        else:
            try:
                gear_val = float(gear)
                if not is_below_gate:
                    rules["landing_gear"] = {
                        "evaluated": True,
                        "pass": True,
                        "status": "ABOVE_GATE",
                        "actual_gear_ratio": gear_val,
                    }
                else:
                    passed = gear_val >= 0.99
                    rules["landing_gear"] = {
                        "evaluated": True,
                        "pass": passed,
                        "actual_gear_ratio": round(gear_val, 2),
                        "error": None if passed else f"GEAR_NOT_DOWN: gear_ratio is {gear_val:.2f}, required 1.0",
                    }
                    if not passed:
                        failed_rules.append("landing_gear")
            except (ValueError, TypeError):
                rules["landing_gear"] = {
                    "evaluated": False,
                    "error": "MISSING_TELEMETRY: gear_ratio (invalid number)",
                }
                missing_fields.append("gear_ratio")

        # 6. Rule: Bank Angle (Roll <= 7 deg on final approach)
        roll = telemetry.get("roll_deg")
        if roll is None:
            rules["bank_angle"] = {
                "evaluated": False,
                "error": "MISSING_TELEMETRY: roll_deg",
            }
            missing_fields.append("roll_deg")
        else:
            try:
                roll_val = float(roll)
                if not is_below_gate:
                    rules["bank_angle"] = {
                        "evaluated": True,
                        "pass": True,
                        "status": "ABOVE_GATE",
                        "actual_roll_deg": roll_val,
                    }
                else:
                    passed = abs(roll_val) <= self.max_roll_deg
                    rules["bank_angle"] = {
                        "evaluated": True,
                        "pass": passed,
                        "actual_roll_deg": round(roll_val, 2),
                        "max_allowed_deg": self.max_roll_deg,
                        "error": None if passed else f"EXCESSIVE_BANK: roll is {roll_val:.1f} deg, max allowed on final is {self.max_roll_deg:.1f} deg",
                    }
                    if not passed:
                        failed_rules.append("bank_angle")
            except (ValueError, TypeError):
                rules["bank_angle"] = {
                    "evaluated": False,
                    "error": "MISSING_TELEMETRY: roll_deg (invalid number)",
                }
                missing_fields.append("roll_deg")

        # Overall evaluation determination
        all_evaluated = len(missing_fields) == 0
        is_stabilized = (len(failed_rules) == 0) if all_evaluated else None

        status = "STABILIZED" if is_stabilized else (
            "UNSTABILIZED" if is_stabilized is False else "UNABLE_TO_EVALUATE_MISSING_DATA"
        )

        return {
            "status": status,
            "evaluated": all_evaluated,
            "is_stabilized": is_stabilized,
            "gate_applied": gate_name,
            "gate_altitude_ft": gate_altitude,
            "is_below_gate": is_below_gate,
            "altitude_agl_ft": alt_agl,
            "failed_rules": failed_rules,
            "missing_telemetry": [f"MISSING_TELEMETRY: {f}" for f in missing_fields],
            "rules": rules,
        }
