"""
Real-data replay engine for the Telemetry Microservice.

Loads actual recorded flight data (e.g. telemetry_essential.csv from real Cessna 172SP UKLL flight)
and plays it back by constructing and transmitting authentic X-Plane 11 UDP packets.

STRICT USER REQUIREMENT:
- NEVER generate synthetic random curves or fake stubs.
- Only real recorded data points are played back.
- If a value was missing in the recording, it is encoded as -999.0 (X-Plane null sentinel).
"""

import asyncio
import csv
import logging
import math
from pathlib import Path
import socket
import struct
import time
from typing import Any, Callable, Dict, List, Optional

logger = logging.getLogger("telemetry-service.replay")

# X-Plane 11 binary constants
XPLANE_HEADER = b"DATA\x00"
XPLANE_NULL = -999.0


def locate_flight_data_file(preferred_path: Optional[str] = None) -> Path:
    """
    Search standard locations for real recorded flight data file.
    Raises FileNotFoundError if no authentic data file exists.
    """
    candidate_paths: List[Path] = []
    base_dir = Path(__file__).resolve().parent
    project_root = base_dir.parent.parent

    if preferred_path:
        p = Path(preferred_path)
        candidate_paths.extend([
            p,
            Path("/app/uploads") / p.name,
            Path("/app/data") / p.name,
            project_root / "data" / p.name,
            project_root / "uploads" / p.name,
            Path("uploads") / p.name,
            Path("data") / p.name,
            base_dir / p,
            project_root / p,
        ])

    # Standard workspace and container locations
    candidate_paths.extend([
        Path("/app/data/telemetry_essential.csv"),
        project_root / "data" / "telemetry_essential.csv",
        base_dir / "data" / "telemetry_essential.csv",
        Path("data/telemetry_essential.csv"),
        Path("/app/data/Data.txt"),
        project_root / "data" / "Data.txt",
    ])

    for cand in candidate_paths:
        try:
            if cand.is_file() and cand.stat().st_size > 0:
                return cand.resolve()
        except OSError:
            continue

    raise FileNotFoundError(
        f"Real recorded flight data file '{preferred_path}' not found in any standard path. "
        "User constraint strictly prohibits synthetic fake curves. "
        "Please provide data/telemetry_essential.csv or upload a valid flight recording."
    )


def _c_to_f(value: Optional[float]) -> Optional[float]:
    return None if value is None else value * 9.0 / 5.0 + 32.0


def _first_present(row: Dict[str, Optional[float]], *keys: str) -> Optional[float]:
    for key in keys:
        value = row.get(key)
        if value is not None:
            return value
    return None


def pack_real_row_to_xplane_udp(row: Dict[str, Optional[float]]) -> bytes:
    """
    Pack a recorded flight row into an X-Plane 11 UDP DATA datagram using the
    native X-Plane 11 row layout, so live and replayed traffic share one parser path.

    Only recorded values are transmitted. A missing value is sent as -999.0, and a
    row whose eight values are all missing is not transmitted at all (the parser then
    reports that subsystem as NO_SIGNAL instead of showing invented numbers).

    Temperatures are transmitted in degrees Fahrenheit, exactly as X-Plane 11 does
    for EGT (row 47) and oil temperature (row 50).
    """
    def sanitize(val: Optional[float]) -> float:
        if val is None or math.isnan(val) or math.isinf(val):
            return XPLANE_NULL
        return float(val)

    def record(channel: int, values: List[Optional[float]]) -> bytes:
        padded = (list(values) + [None] * 8)[:8]
        if all(v is None for v in padded):
            return b""
        return struct.pack("<i8f", channel, *(sanitize(v) for v in padded))

    egt_f = _first_present(row, "egt_f")
    if egt_f is None:
        egt_f = _c_to_f(row.get("egt_c"))
    oil_temp_f = _first_present(row, "oil_temp_f")
    if oil_temp_f is None:
        oil_temp_f = _c_to_f(row.get("oil_temp_c"))

    flap = row.get("flap_ratio")

    records = [
        # 1: real, totl, missn, timer, _, zulu, local, hobbs
        record(1, [None, row.get("total_time"), None, None, None, None, None, None]),
        # 3: kias, keas, ktas, ktgs, _, mph, mphas, mphgs
        record(3, [row.get("indicated_airspeed_kt"), None, row.get("true_airspeed_kt"), row.get("groundspeed_kt")]),
        # 4: mach, _, vvi, _, g normal, g axial, g side, _
        record(4, [None, None, row.get("vertical_speed_fpm"), None,
                   row.get("g_load_normal"), row.get("g_load_axial"), row.get("g_load_side")]),
        # 7: altimeter setting (inHg)
        record(7, [row.get("barometer_setting_inhg")]),
        # 8: elevator, aileron, rudder stick
        record(8, [row.get("elevator_stick"), row.get("aileron_stick"), row.get("rudder_stick")]),
        # 13: trim elev, trim ail, trim rud, flap handle, flap position, slat, sbrake handle, sbrake position
        record(13, [None, None, None, flap, flap]),
        # 14: gear, wheel brakes
        record(14, [row.get("gear_ratio")]),
        # 17: pitch, roll, heading true, heading mag
        record(17, [row.get("pitch_deg"), row.get("roll_deg"), row.get("heading_true_deg"), row.get("heading_mag_deg")]),
        # 18: alpha, beta, hpath, vpath
        record(18, [row.get("aoa_alpha_deg"), row.get("sideslip_beta_deg")]),
        # 20: lat, lon, alt msl, alt agl, on runway, alt indicated
        record(20, [row.get("latitude"), row.get("longitude"), row.get("altitude_msl_ft"),
                    row.get("altitude_agl_ft"), row.get("on_runway"), row.get("altitude_ind_ft")]),
        # 25: throttle commanded
        record(25, [row.get("throttle_ratio")]),
        # 37: engine rpm
        record(37, [row.get("engine_rpm")]),
        # 45: fuel flow gal/h
        record(45, [row.get("fuel_flow_gph")]),
        # 47: EGT deg F
        record(47, [egt_f]),
        # 49: oil pressure psi
        record(49, [row.get("oil_press_psi")]),
        # 50: oil temperature deg F
        record(50, [oil_temp_f]),
        # 62: fuel tank 1, fuel tank 2 (gal); a single recorded total goes into tank 1
        record(62, [_first_present(row, "fuel_tank1_gal", "fuel_qty_gal"), row.get("fuel_tank2_gal")]),
        # Autopilot / flight director / navigation: transmitted only when the recording has them.
        record(102, [None, None, row.get("target_course_deg")]),
        record(103, [None, None, row.get("nav_distance_nm"), row.get("nav_bearing_deg")]),
        record(108, [None, row.get("fd_mode"), row.get("fd_pitch_deg"), row.get("fd_roll_deg")]),
        record(117, [None, row.get("hdg_mode"), row.get("alt_mode")]),
        record(118, [row.get("target_heading_deg"), None, row.get("target_vvi_fpm"), row.get("target_altitude_ft")]),
    ]

    return XPLANE_HEADER + b"".join(records)


class FlightDataReplayer:
    """
    Replays real flight telemetry records chronologically, emitting UDP packets
    at true simulation time deltas.
    """

    def __init__(
        self,
        file_path: Optional[str] = None,
        target_host: str = "127.0.0.1",
        target_port: int = 49000,
        speed_multiplier: float = 1.0,
        loop: bool = True,
    ):
        self.file_path_str = file_path
        self.target_host = target_host
        self.target_port = target_port
        self.speed_multiplier = max(0.1, speed_multiplier)
        self.loop = loop

        self._records: List[Dict[str, Optional[float]]] = []
        self._is_running = False
        self._current_index = 0
        self._task: Optional[asyncio.Task] = None
        self._direct_callback: Optional[Callable[[bytes], None]] = None

    @property
    def is_running(self) -> bool:
        return self._is_running

    @property
    def total_records(self) -> int:
        return len(self._records)

    @property
    def current_index(self) -> int:
        return self._current_index

    @property
    def progress_pct(self) -> float:
        if not self._records:
            return 0.0
        return round((self._current_index / len(self._records)) * 100.0, 1)

    def _parse_csv_file(self, file_path: Path) -> List[Dict[str, Optional[float]]]:
        """Parse standard CSV telemetry file (comma, semicolon, or tab)."""
        records: List[Dict[str, Optional[float]]] = []
        alias_map = {
            "lat": "latitude",
            "latitude_deg": "latitude",
            "lon": "longitude",
            "lng": "longitude",
            "longitude_deg": "longitude",
            "alt": "altitude_msl_ft",
            "alt_ft": "altitude_msl_ft",
            "altitude": "altitude_msl_ft",
            "altitude_msl": "altitude_msl_ft",
            "alt_agl": "altitude_agl_ft",
            "altitude_agl": "altitude_agl_ft",
            "ias": "indicated_airspeed_kt",
            "kias": "indicated_airspeed_kt",
            "airspeed": "indicated_airspeed_kt",
            "tas": "true_airspeed_kt",
            "ktas": "true_airspeed_kt",
            "gs": "groundspeed_kt",
            "ktgs": "groundspeed_kt",
            "vs": "vertical_speed_fpm",
            "vvi": "vertical_speed_fpm",
            "vvi_fpm": "vertical_speed_fpm",
            "pitch": "pitch_deg",
            "roll": "roll_deg",
            "heading": "heading_true_deg",
            "hdg": "heading_true_deg",
            "mag_heading": "heading_mag_deg",
            "aoa": "aoa_alpha_deg",
            "alpha": "aoa_alpha_deg",
            "beta": "sideslip_beta_deg",
            "rpm": "engine_rpm",
            "egt": "egt_c",
            "oil_press": "oil_press_psi",
            "oil_pressure": "oil_press_psi",
            "oil_temp": "oil_temp_c",
            "fuel_flow": "fuel_flow_gph",
            "fuel_qty": "fuel_qty_gal",
            "flaps": "flap_ratio",
            "gear": "gear_ratio",
            "throttle": "throttle_ratio",
            "elevator": "elevator_stick",
        }

        with open(file_path, mode="r", encoding="utf-8", errors="ignore") as f:
            sample = f.read(4096)
            f.seek(0)
            delim = ","
            if ";" in sample and sample.count(";") > sample.count(","):
                delim = ";"
            elif "\t" in sample and sample.count("\t") > sample.count(","):
                delim = "\t"

            reader = csv.DictReader(f, delimiter=delim)
            for raw_row in reader:
                cleaned_row: Dict[str, Optional[float]] = {}
                for k, v in raw_row.items():
                    if not k:
                        continue
                    k_clean = k.strip().lower()
                    target_key = alias_map.get(k_clean, k_clean)
                    v_clean = v.strip() if v else ""
                    if v_clean == "" or v_clean.lower() in ("null", "none", "nan"):
                        cleaned_row[target_key] = None
                    else:
                        try:
                            cleaned_row[target_key] = float(v_clean)
                        except ValueError:
                            cleaned_row[target_key] = None

                if cleaned_row:
                    records.append(cleaned_row)

        return records

    def _parse_xplane_pipe_txt(self, file_path: Path) -> List[Dict[str, Optional[float]]]:
        """Parse X-Plane 11 Data.txt pipe-delimited format."""
        with open(file_path, "r", encoding="latin-1", errors="ignore") as f:
            lines = f.readlines()

        header_idx = None
        data_start_idx = None
        for i, line in enumerate(lines):
            s = line.strip()
            if not s:
                continue
            parts = [p.strip() for p in s.split("|")]
            try:
                float(parts[0])
                data_start_idx = i
                break
            except ValueError:
                header_idx = i

        if header_idx is None or data_start_idx is None:
            raise ValueError(f"Could not locate header and numeric records in {file_path}")

        raw_headers = [c.strip() for c in lines[header_idx].split("|") if c.strip()]
        # X-Plane repeats some labels (e.g. "thro1,_part" for commanded and actual throttle):
        # the first occurrence is the one we want, so later duplicates must not overwrite it.
        header_map: Dict[str, int] = {}
        for i, name in enumerate(raw_headers):
            header_map.setdefault(name, i)

        def get_val(parts_list: List[str], *candidates: str) -> Optional[float]:
            for cand in candidates:
                if cand in header_map:
                    idx = header_map[cand]
                    if idx < len(parts_list):
                        try:
                            val = float(parts_list[idx])
                            if abs(val - XPLANE_NULL) < 0.1 or math.isnan(val):
                                return None
                            return val
                        except ValueError:
                            pass
            return None

        records: List[Dict[str, Optional[float]]] = []
        start_time: Optional[float] = None

        for line in lines[data_start_idx:]:
            s = line.strip()
            if not s:
                continue
            parts = [p.strip() for p in s.split("|")]
            if len(parts) < len(raw_headers):
                continue

            tot_time = get_val(parts, "_totl,_time", "_real,_time")
            if start_time is None and tot_time is not None:
                start_time = tot_time

            rel_time = round(tot_time - start_time, 3) if (tot_time is not None and start_time is not None) else None

            row_dict: Dict[str, Optional[float]] = {
                "time_sec": rel_time,
                "total_time": tot_time,
                "zulu_time": get_val(parts, "_zulu,_time"),
                "latitude": get_val(parts, "__lat,__deg"),
                "longitude": get_val(parts, "__lon,__deg"),
                "altitude_msl_ft": get_val(parts, "__alt,ftmsl"),
                "altitude_agl_ft": get_val(parts, "__alt,ftagl"),
                "indicated_airspeed_kt": get_val(parts, "_Vind,_kias"),
                "true_airspeed_kt": get_val(parts, "Vtrue,_ktas"),
                "groundspeed_kt": get_val(parts, "Vtrue,_ktgs"),
                "vertical_speed_fpm": get_val(parts, "__VVI,__fpm"),
                "pitch_deg": get_val(parts, "pitch,__deg"),
                "roll_deg": get_val(parts, "_roll,__deg"),
                "heading_true_deg": get_val(parts, "hding,_true"),
                "heading_mag_deg": get_val(parts, "hding,__mag"),
                "aoa_alpha_deg": get_val(parts, "alpha,__deg"),
                "sideslip_beta_deg": get_val(parts, "_beta,__deg"),
                "on_runway": get_val(parts, "___on,runwy"),
                "g_load_normal": get_val(parts, "Gload,norml"),
                "g_load_axial": get_val(parts, "Gload,axial"),
                "g_load_side": get_val(parts, "Gload,_side"),
                "flap_ratio": get_val(parts, "_flap,postn", "_flap,handl"),
                "gear_ratio": get_val(parts, "_gear,__0/1"),
                "elevator_stick": get_val(parts, "_elev,stick"),
                "throttle_ratio": get_val(parts, "thro1,_part"),
                "engine_rpm": get_val(parts, "rpm_1,engin", "rpm_1,_prop"),
                # X-Plane 11 writes EGT and oil temperature in degrees Fahrenheit.
                "egt_f": get_val(parts, "EGT_1,__deg"),
                "oil_press_psi": get_val(parts, "OILP1,__psi"),
                "oil_temp_f": get_val(parts, "OILT1,__deg"),
                "fuel_flow_gph": get_val(parts, "FF__1,gal/h"),
                "fuel_tank1_gal": get_val(parts, "fuel1,__gal"),
                "fuel_tank2_gal": get_val(parts, "fuel2,__gal"),
                "barometer_setting_inhg": get_val(parts, "baro_,_inHG"),
            }
            records.append(row_dict)

        return records

    def load_data(self) -> int:
        """
        Load real flight records from CSV or pipe-delimited Data.txt.
        Returns number of records loaded.
        """
        resolved_path = locate_flight_data_file(self.file_path_str)
        self.file_path_str = str(resolved_path)
        logger.info(f"Loading authentic flight data from {resolved_path}")

        with open(resolved_path, mode="r", encoding="utf-8", errors="ignore") as f:
            first_lines = [f.readline() for _ in range(10)]
            first_lines = [l for l in first_lines if l.strip()]

        is_pipe_format = any("|" in l for l in first_lines[:5])
        if is_pipe_format:
            records = self._parse_xplane_pipe_txt(resolved_path)
        else:
            records = self._parse_csv_file(resolved_path)

        if not records:
            raise ValueError(f"Flight data file {resolved_path} contains 0 valid data rows.")

        self._records = records
        self._current_index = 0
        logger.info(f"Successfully loaded {len(self._records)} real flight telemetry rows from {resolved_path.name}.")
        return len(self._records)

    async def start(
        self,
        direct_callback: Optional[Callable[[bytes], None]] = None,
    ) -> None:
        """Start async replay loop."""
        if self._is_running:
            logger.warning("Replay already running.")
            return

        if not self._records:
            self.load_data()

        self._direct_callback = direct_callback
        self._is_running = True
        self._task = asyncio.create_task(self._run_loop())
        logger.info(
            f"Flight replayer started. Target: {self.target_host}:{self.target_port}, "
            f"Speed: {self.speed_multiplier}x, Loop: {self.loop}"
        )

    def stop(self) -> None:
        """Stop replay."""
        self._is_running = False
        if self._task and not self._task.done():
            self._task.cancel()
        logger.info("Flight replayer stopped.")

    def set_speed(self, speed: float) -> None:
        """Dynamically adjust replay speed."""
        self.speed_multiplier = max(0.1, speed)
        logger.info(f"Replay speed set to {self.speed_multiplier}x")

    async def _run_loop(self) -> None:
        """Internal asynchronous playback loop."""
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.setblocking(False)

        try:
            while self._is_running:
                for i, row in enumerate(self._records):
                    if not self._is_running:
                        break

                    self._current_index = i
                    packet_bytes = pack_real_row_to_xplane_udp(row)

                    # Send either directly to callback or via UDP
                    if self._direct_callback:
                        self._direct_callback(packet_bytes)
                    else:
                        try:
                            sock.sendto(packet_bytes, (self.target_host, self.target_port))
                        except Exception as e:
                            logger.error(f"Failed to transmit replay UDP datagram: {e}")

                    # Calculate delay to next record based on recorded time_sec or total_time
                    if i + 1 < len(self._records):
                        curr_t = row.get("time_sec") if row.get("time_sec") is not None else row.get("total_time")
                        next_t = self._records[i + 1].get("time_sec") if self._records[i + 1].get("time_sec") is not None else self._records[i + 1].get("total_time")
                        if curr_t is not None and next_t is not None and next_t >= curr_t:
                            delta_sec = (next_t - curr_t) / self.speed_multiplier
                        else:
                            delta_sec = 0.04 / self.speed_multiplier
                    else:
                        delta_sec = 0.04 / self.speed_multiplier

                    # Bound delta between 0.005s and 2.0s
                    delay = max(0.005, min(delta_sec, 2.0))
                    await asyncio.sleep(delay)

                if not self.loop or not self._is_running:
                    logger.info("Flight replay completed end of dataset.")
                    break

                logger.info("Flight replay dataset ended. Looping from start.")
        except asyncio.CancelledError:
            pass
        finally:
            sock.close()
            self._is_running = False


# Standalone runner for testing or manual transmitter invocation
if __name__ == "__main__":
    import argparse

    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

    parser = argparse.ArgumentParser(description="Real X-Plane Telemetry UDP Replay Engine")
    parser.add_argument("--file", type=str, default="../../data/telemetry_essential.csv", help="Path to telemetry CSV")
    parser.add_argument("--host", type=str, default="127.0.0.1", help="Target UDP host")
    parser.add_argument("--port", type=int, default=49000, help="Target UDP port")
    parser.add_argument("--speed", type=float, default=1.0, help="Replay speed multiplier")
    parser.add_argument("--once", action="store_true", help="Do not loop; play once and exit")

    args = parser.parse_args()

    replayer = FlightDataReplayer(
        file_path=args.file,
        target_host=args.host,
        target_port=args.port,
        speed_multiplier=args.speed,
        loop=not args.once,
    )

    async def main():
        await replayer.start()
        try:
            while replayer.is_running:
                print(f"\rReplaying flight: {replayer.current_index}/{replayer.total_records} ({replayer.progress_pct}%)", end="")
                await asyncio.sleep(0.5)
        except KeyboardInterrupt:
            replayer.stop()
            print("\nStopped.")

    asyncio.run(main())
