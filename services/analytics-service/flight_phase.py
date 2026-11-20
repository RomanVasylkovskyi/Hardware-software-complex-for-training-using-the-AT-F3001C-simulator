"""
Flight phase tracking and touchdown detection for real-time and recorded telemetry.

Why this exists: X-Plane's "on runway" flag means "the aircraft is over the runway
surface", not "weight on wheels". In the UKLL recording it switches to 1 at 61 ft AGL
while crossing the runway, so it cannot be used to detect a touchdown or to decide
whether the aircraft is airborne. This module derives both from height above ground,
with hysteresis and timing, and keeps state between frames.

Touchdown metrics are taken from a window around the first ground contact:
- vertical speed: the most negative VSI in the last second before contact
  (VSI lags and decays immediately after contact);
- vertical load: the peak normal G within one second after contact;
- roll, position (centerline offset): at the contact frame.
"""

from __future__ import annotations

import time
from collections import deque
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Deque, Dict, Iterable, List, Optional, Tuple


class FlightPhase(str, Enum):
    UNKNOWN = "UNKNOWN"
    GROUND = "GROUND"
    CLIMB = "CLIMB"
    CRUISE = "CRUISE"
    APPROACH = "APPROACH"
    LANDING_ROLL = "LANDING_ROLL"


def to_float(value: Any) -> Optional[float]:
    """Coerce telemetry values (including CSV strings and booleans) to float; None if invalid."""
    if value is None or isinstance(value, bool):
        return None if value is None else float(value)
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    if result != result:  # NaN
        return None
    return result


def normalize_frame(frame: Dict[str, Any]) -> Dict[str, Any]:
    """Return a copy of the frame with numeric fields coerced from strings (CSV rows)."""
    out: Dict[str, Any] = {}
    for key, value in frame.items():
        if isinstance(value, str):
            converted = to_float(value)
            out[key] = converted if converted is not None else (None if value.strip() == "" else value)
        else:
            out[key] = value
    return out


@dataclass
class TouchdownEvent:
    touchdown_id: int
    time_sec: float
    contact_frame: Dict[str, Any]
    min_vsi_fpm: Optional[float]
    peak_g: Optional[float]
    complete: bool = False

    def as_frame(self) -> Dict[str, Any]:
        """Touchdown frame with VSI / G replaced by their windowed extremes."""
        frame = dict(self.contact_frame)
        if self.min_vsi_fpm is not None:
            frame["vertical_speed_fpm"] = self.min_vsi_fpm
        if self.peak_g is not None:
            frame["g_load_normal"] = self.peak_g
        frame["time_sec"] = self.time_sec
        return frame


@dataclass
class PhaseState:
    phase: FlightPhase
    is_airborne: Optional[bool]
    on_approach: bool
    touchdown: Optional[TouchdownEvent]
    new_touchdown: bool
    time_sec: Optional[float]


@dataclass
class FlightPhaseTracker:
    """
    Stateful classifier. Feed frames in chronological order with update().
    Thresholds are for light piston aircraft (C172) and can be overridden.
    """

    liftoff_agl_ft: float = 10.0          # sustained height above this => airborne
    liftoff_confirm_sec: float = 2.0
    contact_agl_ft: float = 1.0           # height at/below this after being airborne => ground contact
    approach_ceiling_agl_ft: float = 1500.0
    approach_descent_fpm: float = -150.0  # smoothed VSI below this => descending
    climb_fpm: float = 300.0
    landing_roll_sec: float = 30.0
    vsi_lookback_sec: float = 1.0
    g_window_sec: float = 1.0

    airborne: Optional[bool] = None
    _above_since: Optional[float] = None
    _last_time: Optional[float] = None
    _vsi_ema: Optional[float] = None
    _history: Deque[Tuple[float, Optional[float]]] = field(default_factory=lambda: deque(maxlen=200))
    _touchdown_count: int = 0
    _pending: Optional[TouchdownEvent] = None
    last_touchdown: Optional[TouchdownEvent] = None
    _clock_origin: float = field(default_factory=time.monotonic)

    def reset(self) -> None:
        self.airborne = None
        self._above_since = None
        self._last_time = None
        self._vsi_ema = None
        self._history.clear()
        self._pending = None
        self.last_touchdown = None

    def _frame_time(self, frame: Dict[str, Any]) -> float:
        t = to_float(frame.get("time_sec"))
        if t is None:
            t = to_float(frame.get("total_time_sec"))
        if t is None:
            t = time.monotonic() - self._clock_origin
        return t

    def update(self, raw_frame: Dict[str, Any]) -> PhaseState:
        frame = normalize_frame(raw_frame)
        t = self._frame_time(frame)

        # Time going backwards = a replay restarted or a new recording: start over.
        if self._last_time is not None and t < self._last_time - 1.0:
            self.reset()
        dt = 0.0 if self._last_time is None else max(0.0, t - self._last_time)
        self._last_time = t

        agl = to_float(frame.get("altitude_agl_ft"))
        vsi = to_float(frame.get("vertical_speed_fpm"))
        g = to_float(frame.get("g_load_normal"))
        self._history.append((t, vsi))

        if vsi is not None:
            alpha = 1.0 if self._vsi_ema is None else min(1.0, dt / 1.5) if dt > 0 else 0.2
            self._vsi_ema = vsi if self._vsi_ema is None else self._vsi_ema + alpha * (vsi - self._vsi_ema)

        new_touchdown = False

        # Close the measurement window of a touchdown in progress.
        if self._pending is not None:
            if g is not None and (self._pending.peak_g is None or g > self._pending.peak_g):
                self._pending.peak_g = g
            if t - self._pending.time_sec >= self.g_window_sec:
                self._pending.complete = True
                self.last_touchdown = self._pending
                self._pending = None
                new_touchdown = True

        if agl is not None:
            if self.airborne is None:
                self.airborne = agl > self.liftoff_agl_ft
            elif not self.airborne:
                if agl > self.liftoff_agl_ft:
                    if self._above_since is None:
                        self._above_since = t
                    elif t - self._above_since >= self.liftoff_confirm_sec:
                        self.airborne = True
                        self._above_since = None
                else:
                    self._above_since = None
            elif agl <= self.contact_agl_ft:
                self.airborne = False
                self._above_since = None
                self._touchdown_count += 1
                lookback = [v for (ts, v) in self._history if v is not None and t - ts <= self.vsi_lookback_sec]
                self._pending = TouchdownEvent(
                    touchdown_id=self._touchdown_count,
                    time_sec=t,
                    contact_frame=frame,
                    min_vsi_fpm=min(lookback) if lookback else vsi,
                    peak_g=g,
                )

        phase = self._classify(agl, t)
        on_approach = phase == FlightPhase.APPROACH
        return PhaseState(
            phase=phase,
            is_airborne=self.airborne,
            on_approach=on_approach,
            touchdown=self.last_touchdown,
            new_touchdown=new_touchdown,
            time_sec=t,
        )

    def _classify(self, agl: Optional[float], t: float) -> FlightPhase:
        if self.airborne is None or agl is None:
            return FlightPhase.UNKNOWN
        if not self.airborne:
            recent = self._pending or self.last_touchdown
            if recent is not None and t - recent.time_sec <= self.landing_roll_sec:
                return FlightPhase.LANDING_ROLL
            return FlightPhase.GROUND
        vsi = self._vsi_ema
        if vsi is not None and vsi >= self.climb_fpm:
            return FlightPhase.CLIMB
        if agl <= self.approach_ceiling_agl_ft and vsi is not None and vsi <= self.approach_descent_fpm:
            return FlightPhase.APPROACH
        return FlightPhase.CRUISE


def find_touchdowns(frames: Iterable[Dict[str, Any]]) -> List[TouchdownEvent]:
    """Run the tracker over a recorded session and return every completed touchdown."""
    tracker = FlightPhaseTracker()
    events: List[TouchdownEvent] = []
    for frame in frames:
        state = tracker.update(frame)
        if state.new_touchdown and state.touchdown is not None:
            events.append(state.touchdown)
    if tracker._pending is not None:  # recording ended inside the measurement window
        tracker._pending.complete = True
        events.append(tracker._pending)
    return events
