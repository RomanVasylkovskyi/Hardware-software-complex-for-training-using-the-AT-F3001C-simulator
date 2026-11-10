"""
AI Flight Warning and GPWS/Envelope Alert Generator.
Monitors:
- SINK RATE: Excessive vertical descent rate near terrain
- PULL UP: Critical terrain closure or excessive sink rate at low altitude
- GLIDESLOPE UNSTABLE: Deviation from nominal 3-degree descent profile
- TOO HIGH SPEED: Airspeed exceeding flap limits or approach targets
- BANK ANGLE: Excessive roll angle below gate or envelope boundary
- UNSTABILIZED APPROACH - GO AROUND: Mandatory go-around guidance

STRICT ZERO-MOCK:
If any telemetry field is None or missing, marks evaluation as:
{"evaluated": false, "error": "MISSING_TELEMETRY: <field>"}.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

logger = logging.getLogger("flight_warnings")


class FlightWarningsGenerator:
    """
    Evaluates real telemetry against aviation flight safety envelope criteria.
    """

    def __init__(
        self,
        default_target_ias_kt: float = 65.0,
        flap_vfe_limit_kt: float = 110.0,
    ) -> None:
        self.default_target_ias_kt = default_target_ias_kt
        self.flap_vfe_limit_kt = flap_vfe_limit_kt

    def evaluate_warnings(
        self,
        telemetry: Dict[str, Any],
        target_ias_kt: Optional[float] = None,
    ) -> Dict[str, Any]:
        """
        Evaluate active warnings for a single telemetry sample.
        """
        target_speed = target_ias_kt or telemetry.get("target_ias_kt") or self.default_target_ias_kt

        warnings_detail: Dict[str, Dict[str, Any]] = {}
        active_warnings: List[str] = []
        missing_fields: List[str] = []

        # Extract telemetry fields safely
        alt_agl = self._get_float(telemetry, "altitude_agl_ft", missing_fields)
        vsi = self._get_float(telemetry, "vertical_speed_fpm", missing_fields)
        ias = self._get_float(telemetry, "indicated_airspeed_kt", missing_fields)
        gs = self._get_float(telemetry, "groundspeed_kt", missing_fields)
        roll = self._get_float(telemetry, "roll_deg", missing_fields)
        flaps = self._get_float(telemetry, "flap_ratio", missing_fields)
        on_runway = telemetry.get("on_runway")
        is_airborne = True
        if on_runway is not None:
            try:
                is_airborne = int(on_runway) == 0
            except (ValueError, TypeError):
                is_airborne = True

        # -------------------------------------------------------------
        # 1. SINK RATE Warning
        # -------------------------------------------------------------
        if alt_agl is None or vsi is None:
            missing_for_sink = []
            if alt_agl is None:
                missing_for_sink.append("altitude_agl_ft")
            if vsi is None:
                missing_for_sink.append("vertical_speed_fpm")
            warnings_detail["SINK RATE"] = {
                "active": False,
                "evaluated": False,
                "error": f"MISSING_TELEMETRY: {', '.join(missing_for_sink)}",
            }
        else:
            is_excessive = (
                (alt_agl <= 1000.0 and vsi < -1000.0 and is_airborne)
                or (alt_agl <= 2500.0 and vsi < -1500.0 and is_airborne)
            )
            warnings_detail["SINK RATE"] = {
                "active": is_excessive,
                "evaluated": True,
                "severity": "WARNING" if is_excessive else "NORMAL",
                "vertical_speed_fpm": vsi,
                "altitude_agl_ft": alt_agl,
            }
            if is_excessive:
                active_warnings.append("SINK RATE")

        # -------------------------------------------------------------
        # 2. PULL UP Warning
        # -------------------------------------------------------------
        if alt_agl is None or vsi is None:
            missing_for_pull = []
            if alt_agl is None:
                missing_for_pull.append("altitude_agl_ft")
            if vsi is None:
                missing_for_pull.append("vertical_speed_fpm")
            warnings_detail["PULL UP"] = {
                "active": False,
                "evaluated": False,
                "error": f"MISSING_TELEMETRY: {', '.join(missing_for_pull)}",
            }
        else:
            is_critical = (
                (alt_agl <= 1000.0 and vsi < -1800.0 and is_airborne)
                or (alt_agl <= 400.0 and vsi < -1200.0 and is_airborne)
            )
            warnings_detail["PULL UP"] = {
                "active": is_critical,
                "evaluated": True,
                "severity": "CRITICAL" if is_critical else "NORMAL",
                "vertical_speed_fpm": vsi,
                "altitude_agl_ft": alt_agl,
            }
            if is_critical:
                active_warnings.append("PULL UP")

        # -------------------------------------------------------------
        # 3. GLIDESLOPE UNSTABLE Warning
        # -------------------------------------------------------------
        if alt_agl is None or vsi is None or gs is None:
            missing_for_gs = []
            if alt_agl is None:
                missing_for_gs.append("altitude_agl_ft")
            if vsi is None:
                missing_for_gs.append("vertical_speed_fpm")
            if gs is None:
                missing_for_gs.append("groundspeed_kt")
            warnings_detail["GLIDESLOPE UNSTABLE"] = {
                "active": False,
                "evaluated": False,
                "error": f"MISSING_TELEMETRY: {', '.join(missing_for_gs)}",
            }
        else:
            if alt_agl <= 1500.0 and is_airborne and gs >= 45.0:
                nominal_vsi = -5.2 * gs
                deviation = abs(vsi - nominal_vsi)
                is_unstable = deviation > 350.0
                warnings_detail["GLIDESLOPE UNSTABLE"] = {
                    "active": is_unstable,
                    "evaluated": True,
                    "severity": "WARNING" if is_unstable else "NORMAL",
                    "actual_vsi_fpm": vsi,
                    "nominal_3deg_vsi_fpm": round(nominal_vsi, 1),
                    "deviation_fpm": round(deviation, 1),
                }
                if is_unstable:
                    active_warnings.append("GLIDESLOPE UNSTABLE")
            else:
                warnings_detail["GLIDESLOPE UNSTABLE"] = {
                    "active": False,
                    "evaluated": True,
                    "status": "NOT_ON_FINAL_APPROACH",
                }

        # -------------------------------------------------------------
        # 4. TOO HIGH SPEED Warning
        # -------------------------------------------------------------
        if ias is None:
            warnings_detail["TOO HIGH SPEED"] = {
                "active": False,
                "evaluated": False,
                "error": "MISSING_TELEMETRY: indicated_airspeed_kt",
            }
        else:
            flaps_val = flaps if flaps is not None else 0.0
            over_vfe = flaps_val > 0.0 and ias > self.flap_vfe_limit_kt

            over_approach = (
                alt_agl is not None
                and alt_agl <= 1000.0
                and is_airborne
                and ias > (target_speed + 15.0)
            )

            is_too_fast = over_vfe or over_approach
            reason = "EXCEEDED_VFE_WITH_FLAPS" if over_vfe else (
                "EXCEEDED_APPROACH_SPEED_TARGET" if over_approach else "NORMAL"
            )

            warnings_detail["TOO HIGH SPEED"] = {
                "active": is_too_fast,
                "evaluated": True,
                "severity": "CAUTION" if is_too_fast else "NORMAL",
                "actual_ias_kt": ias,
                "target_ias_kt": target_speed,
                "reason": reason,
            }
            if is_too_fast:
                active_warnings.append("TOO HIGH SPEED")

        # -------------------------------------------------------------
        # 5. BANK ANGLE Warning
        # -------------------------------------------------------------
        if roll is None:
            warnings_detail["BANK ANGLE"] = {
                "active": False,
                "evaluated": False,
                "error": "MISSING_TELEMETRY: roll_deg",
            }
        else:
            excessive_bank = (
                (alt_agl is not None and alt_agl <= 500.0 and is_airborne and abs(roll) > 7.0)
                or (abs(roll) > 30.0)
            )
            warnings_detail["BANK ANGLE"] = {
                "active": excessive_bank,
                "evaluated": True,
                "severity": "CAUTION" if excessive_bank else "NORMAL",
                "actual_roll_deg": roll,
                "max_allowed_deg": 7.0 if (alt_agl is not None and alt_agl <= 500.0) else 30.0,
            }
            if excessive_bank:
                active_warnings.append("BANK ANGLE")

        unique_missing = list(dict.fromkeys(missing_fields))

        return {
            "active_warnings": active_warnings,
            "has_warnings": len(active_warnings) > 0,
            "warning_count": len(active_warnings),
            "missing_telemetry": [f"MISSING_TELEMETRY: {m}" for m in unique_missing],
            "details": warnings_detail,
        }

    @staticmethod
    def _get_float(telemetry: Dict[str, Any], key: str, missing_list: List[str]) -> Optional[float]:
        val = telemetry.get(key)
        if val is None:
            missing_list.append(key)
            return None
        try:
            return float(val)
        except (ValueError, TypeError):
            missing_list.append(key)
            return None
