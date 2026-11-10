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

    if preferred_path:
        p = Path(preferred_path)
        candidate_paths.extend([
            p,
            Path(__file__).resolve().parent / p,
            Path(__file__).resolve().parent.parent.parent / p,
        ])

    # Standard workspace and container locations
    base_dir = Path(__file__).resolve().parent
    project_root = base_dir.parent.parent

    candidate_paths.extend([
        project_root / "data" / "telemetry_essential.csv",
        base_dir / "data" / "telemetry_essential.csv",
        Path("/app/data/telemetry_essential.csv"),
        Path("data/telemetry_essential.csv"),
        project_root / "data" / "Data.txt",
        Path("/app/data/Data.txt"),
    ])

    for cand in candidate_paths:
        try:
            if cand.is_file() and cand.stat().st_size > 0:
                return cand.resolve()
        except OSError:
            continue

    raise FileNotFoundError(
        "Real recorded flight data file not found in any standard path. "
        "User constraint strictly prohibits synthetic fake curves. "
        "Please provide data/telemetry_essential.csv."
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

    def load_data(self) -> int:
        """
        Load real flight records from CSV file.
        Returns number of records loaded.
        """
        resolved_path = locate_flight_data_file(self.file_path_str)
        logger.info(f"Loading authentic flight data from {resolved_path}")

        records: List[Dict[str, Optional[float]]] = []
        with open(resolved_path, mode="r", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            for row_idx, raw_row in enumerate(reader):
                cleaned_row: Dict[str, Optional[float]] = {}
                for k, v in raw_row.items():
                    k_clean = k.strip()
                    v_clean = v.strip() if v else ""
                    if v_clean == "" or v_clean.lower() in ("null", "none", "nan"):
                        cleaned_row[k_clean] = None
                    else:
                        try:
                            cleaned_row[k_clean] = float(v_clean)
                        except ValueError:
                            cleaned_row[k_clean] = None

                records.append(cleaned_row)

        if not records:
            raise ValueError(f"Flight data file {resolved_path} contains 0 valid data rows.")

        self._records = records
        logger.info(f"Successfully loaded {len(self._records)} real flight telemetry rows.")
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

                    # Calculate delay to next record based on recorded time_sec
                    if i + 1 < len(self._records):
                        curr_t = row.get("time_sec")
                        next_t = self._records[i + 1].get("time_sec")
                        if curr_t is not None and next_t is not None and next_t >= curr_t:
                            delta_sec = (next_t - curr_t) / self.speed_multiplier
                        else:
                            delta_sec = 0.5 / self.speed_multiplier
                    else:
                        delta_sec = 0.5 / self.speed_multiplier

                    # Bound delta between 0.01s and 2.0s
                    delay = max(0.01, min(delta_sec, 2.0))
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
