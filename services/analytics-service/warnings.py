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

import importlib.util
import os
import sys
from typing import Any, Dict, List, Optional

# ---------------------------------------------------------------------------
# Compatibility Bridge: If Python stdlib or external package imports 'warnings',
# ensure standard library warnings attributes are preserved and available.
# ---------------------------------------------------------------------------
_cur_dir = os.path.dirname(os.path.abspath(__file__))
_stdlib_warnings = None
for _p in sys.path:
    if _p and os.path.abspath(_p) != _cur_dir:
        _cand = os.path.join(_p, "warnings.py")
        if os.path.isfile(_cand):
            try:
                _spec = importlib.util.spec_from_file_location("_real_stdlib_warnings", _cand)
                if _spec and _spec.loader:
                    _stdlib_warnings = importlib.util.module_from_spec(_spec)
                    sys.modules["_real_stdlib_warnings"] = _stdlib_warnings
                    _spec.loader.exec_module(_stdlib_warnings)
                    break
            except Exception:
                pass

if _stdlib_warnings is not None:
    for _k, _v in _stdlib_warnings.__dict__.items():
        if not _k.startswith("__"):
            globals()[_k] = _v


from ai_warnings import FlightWarningsGenerator

# Register on current warnings module and sys.modules['warnings']
if "warnings" in sys.modules:
    setattr(sys.modules["warnings"], "FlightWarningsGenerator", FlightWarningsGenerator)
