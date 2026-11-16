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


def pack_real_row_to_xplane_udp(row: Dict[str, Optional[float]]) -> bytes:
    """
    Pack a real flight recording data row into an authentic X-Plane 11 UDP datagram.
    Format: b'DATA\\x00' + N * 36 bytes (<i8f).
    Unrecorded fields are encoded as -999.0.
    """
    def sanitize(val: Optional[float]) -> float:
        if val is None or math.isnan(val) or math.isinf(val):
            return XPLANE_NULL
        return float(val)

    # 1. Channel 0: Frame rates & Total time
    total_time = sanitize(row.get("total_time"))
    ch0 = struct.pack(
        "<i8f",
        0,
        20.0,        # f_act (FPS)
        20.0,        # f_sim (FPS)
        total_time,  # total time sec
        XPLANE_NULL, XPLANE_NULL, XPLANE_NULL, XPLANE_NULL, XPLANE_NULL
    )

    # 2. Channel 3: Speeds (vind_kias, vind_keas, vt_ktas, vt_ktgs, vind_mph, vt_mphs, vt_mphg, spare)
    kias = sanitize(row.get("indicated_airspeed_kt"))
    ktas = sanitize(row.get("true_airspeed_kt"))
    ktgs = sanitize(row.get("groundspeed_kt"))
    ch3 = struct.pack(
        "<i8f",
        3,
        kias, XPLANE_NULL, ktas, ktgs,
        XPLANE_NULL, XPLANE_NULL, XPLANE_NULL, XPLANE_NULL
    )

    # 3. Channel 4: Mach, VVI, G-loads (mach, vvi_fpm, g_nrml, g_axil, g_side, spare, spare, spare)
    vvi = sanitize(row.get("vertical_speed_fpm"))
    g_nrml = sanitize(row.get("g_load_normal"))
    g_axil = sanitize(row.get("g_load_axial"))
    g_side = sanitize(row.get("g_load_side"))
    ch4 = struct.pack(
        "<i8f",
        4,
        XPLANE_NULL, vvi, g_nrml, g_axil, g_side,
        XPLANE_NULL, XPLANE_NULL, XPLANE_NULL
    )

    # 4. Channel 8: Flight Controls (elev, ailrn, ruddr, ...)
    elev = sanitize(row.get("elevator_stick"))
    ch8 = struct.pack(
        "<i8f",
        8,
        elev, XPLANE_NULL, XPLANE_NULL,
        XPLANE_NULL, XPLANE_NULL, XPLANE_NULL, XPLANE_NULL, XPLANE_NULL
    )

    # 5. Channel 13: Trims & Flaps (elev_trim, ailrn_trim, ruddr_trim, flap_ratio, flap_actual, ...)
    flap = sanitize(row.get("flap_ratio"))
    ch13 = struct.pack(
        "<i8f",
        13,
        XPLANE_NULL, XPLANE_NULL, XPLANE_NULL, flap, flap,
        XPLANE_NULL, XPLANE_NULL, XPLANE_NULL
    )

    # 6. Channel 14: Gear & Brakes (gear_ratio, wbrak_l, wbrak_r, ...)
    gear = sanitize(row.get("gear_ratio"))
    ch14 = struct.pack(
        "<i8f",
        14,
        gear, XPLANE_NULL, XPLANE_NULL,
        XPLANE_NULL, XPLANE_NULL, XPLANE_NULL, XPLANE_NULL, XPLANE_NULL
    )

    # 7. Channel 17: Pitch, Roll, Headings (pitch, roll, hdng_true, hdng_mag, ...)
    pitch = sanitize(row.get("pitch_deg"))
    roll = sanitize(row.get("roll_deg"))
    hdng_t = sanitize(row.get("heading_true_deg"))
    hdng_m = sanitize(row.get("heading_mag_deg"))
    ch17 = struct.pack(
        "<i8f",
        17,
        pitch, roll, hdng_t, hdng_m,
        XPLANE_NULL, XPLANE_NULL, XPLANE_NULL, XPLANE_NULL
    )

    # 8. Channel 18: AoA, Sideslip (aoa_alpha, sideslip_beta, hpath, vpath, ...)
    aoa = sanitize(row.get("aoa_alpha_deg"))
    beta = sanitize(row.get("sideslip_beta_deg"))
    ch18 = struct.pack(
        "<i8f",
        18,
        aoa, beta, XPLANE_NULL, XPLANE_NULL,
        XPLANE_NULL, XPLANE_NULL, XPLANE_NULL, XPLANE_NULL
    )

    # 9. Channel 20: Lat, Lon, Altitude (lat, lon, alt_msl, alt_agl, on_runway, alt_ind, ...)
    lat = sanitize(row.get("latitude"))
    lon = sanitize(row.get("longitude"))
    alt_msl = sanitize(row.get("altitude_msl_ft"))
    alt_agl = sanitize(row.get("altitude_agl_ft"))
    on_rwy = sanitize(row.get("on_runway"))
    ch20 = struct.pack(
        "<i8f",
        20,
        lat, lon, alt_msl, alt_agl, on_rwy,
        XPLANE_NULL, XPLANE_NULL, XPLANE_NULL
    )

    # 10. Channel 25: Throttle commanded
    throt = sanitize(row.get("throttle_ratio"))
    ch25 = struct.pack(
        "<i8f",
        25,
        throt, XPLANE_NULL, XPLANE_NULL, XPLANE_NULL,
        XPLANE_NULL, XPLANE_NULL, XPLANE_NULL, XPLANE_NULL
    )

    # 11. Channel 37: Engine RPM
    rpm = sanitize(row.get("engine_rpm"))
    ch37 = struct.pack(
        "<i8f",
        37,
        rpm, XPLANE_NULL, XPLANE_NULL, XPLANE_NULL,
        XPLANE_NULL, XPLANE_NULL, XPLANE_NULL, XPLANE_NULL
    )

    # 12. Channel 39: Oil Temp and Pressure (oil_temp_degc, oil_press_psi)
    oil_t = sanitize(row.get("oil_temp_c"))
    oil_p = sanitize(row.get("oil_press_psi"))
    ch39 = struct.pack(
        "<i8f",
        39,
        oil_t, oil_p, XPLANE_NULL, XPLANE_NULL,
        XPLANE_NULL, XPLANE_NULL, XPLANE_NULL, XPLANE_NULL
    )

    # 13. Channel 43: Exhaust Gas Temperature (EGT)
    egt = sanitize(row.get("egt_c"))
    ch43 = struct.pack(
        "<i8f",
        43,
        egt, XPLANE_NULL, XPLANE_NULL, XPLANE_NULL,
        XPLANE_NULL, XPLANE_NULL, XPLANE_NULL, XPLANE_NULL
    )

    # 14. Channel 47: Fuel Flow (GPH)
    ff_gph = sanitize(row.get("fuel_flow_gph"))
    ch47 = struct.pack(
        "<i8f",
        47,
        ff_gph, XPLANE_NULL, XPLANE_NULL, XPLANE_NULL,
        XPLANE_NULL, XPLANE_NULL, XPLANE_NULL, XPLANE_NULL
    )

    # 15. Channel 62: Fuel Quantity (GAL)
    fuel_qty = sanitize(row.get("fuel_qty_gal"))
    ch62 = struct.pack(
        "<i8f",
        62,
        fuel_qty, XPLANE_NULL, XPLANE_NULL, XPLANE_NULL,
        XPLANE_NULL, XPLANE_NULL, XPLANE_NULL, XPLANE_NULL
    )

    # 16. Channel 21: Flight Director (pitch, roll, hdg)
    fd_pitch = sanitize(row.get("fd_pitch_deg", row.get("pitch_deg", 0.0)))
    fd_roll = sanitize(row.get("fd_roll_deg", 0.0))
    ch21 = struct.pack(
        "<i8f",
        21,
        fd_pitch, fd_roll, XPLANE_NULL,
        XPLANE_NULL, XPLANE_NULL, XPLANE_NULL, XPLANE_NULL, XPLANE_NULL
    )

    # 17. Channel 117: Autopilot Reference (alt, vvi, spd)
    tgt_alt = sanitize(row.get("target_altitude_ft", 2000.0))
    tgt_vvi = sanitize(row.get("target_vvi_fpm", 0.0))
    tgt_spd = sanitize(row.get("target_speed_kt", 110.0))
    ch117 = struct.pack(
        "<i8f",
        117,
        tgt_alt, tgt_vvi, tgt_spd,
        XPLANE_NULL, XPLANE_NULL, XPLANE_NULL, XPLANE_NULL, XPLANE_NULL
    )

    # 18. Channel 118: Autopilot Nav & Heading (hdg, nav2, crs)
    tgt_hdg = sanitize(row.get("target_heading_deg", 127.0))
    tgt_crs = sanitize(row.get("target_course_deg", 127.0))
    ch118 = struct.pack(
        "<i8f",
        118,
        tgt_hdg, XPLANE_NULL, tgt_crs,
        XPLANE_NULL, XPLANE_NULL, XPLANE_NULL, XPLANE_NULL, XPLANE_NULL
    )

    # 19. Channel 119: Autopilot Modes (fd, ap, alt, hdg, nav, app)
    fd_m = sanitize(row.get("fd_mode", 1.0))
    ap_m = sanitize(row.get("ap_mode", 2.0))
    alt_m = sanitize(row.get("alt_mode", 2.0))
    hdg_m = sanitize(row.get("hdg_mode", 2.0))
    nav_m = sanitize(row.get("nav_mode", 0.0))
    app_m = sanitize(row.get("app_mode", 0.0))
    ch119 = struct.pack(
        "<i8f",
        119,
        fd_m, ap_m, alt_m, hdg_m, nav_m, app_m,
        XPLANE_NULL, XPLANE_NULL
    )

    # 20. Channel 7: System Pressures / Altimeter Barometer Setting (baro-pilot inHg)
    baro_val = sanitize(row.get("barometer_setting_inhg", 28.70))
    ch7 = struct.pack(
        "<i8f",
        7,
        baro_val, XPLANE_NULL, XPLANE_NULL, XPLANE_NULL,
        XPLANE_NULL, XPLANE_NULL, XPLANE_NULL, XPLANE_NULL
    )

    return (
        XPLANE_HEADER
        + ch0
        + ch3
        + ch4
        + ch8
        + ch13
        + ch14
        + ch17
        + ch18
        + ch20
        + ch25
        + ch37
        + ch39
        + ch43
        + ch47
        + ch62
        + ch21
        + ch117
        + ch118
        + ch119
        + ch7
    )


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
        header_map = {raw_headers[i]: i for i in range(len(raw_headers))}

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
                "egt_c": get_val(parts, "EGT_1,__deg"),
                "oil_press_psi": get_val(parts, "OILP1,__psi"),
                "oil_temp_c": get_val(parts, "OILT1,__deg"),
                "fuel_flow_gph": get_val(parts, "FF__1,gal/h"),
                "fuel_qty_gal": get_val(parts, "fuel1,__gal"),
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
