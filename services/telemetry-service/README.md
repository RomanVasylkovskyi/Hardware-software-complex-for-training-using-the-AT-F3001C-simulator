# Telemetry Microservice (AT-F3001C Hardware-Software Complex)

The **Telemetry Microservice** is the foundational real-time telemetry ingestion and streaming engine for the AT-F3001C flight simulator complex. It interfaces directly with **X-Plane 11**, receiving binary UDP datagrams, enforcing strict zero-stub data integrity, tracking connection health, and broadcasting structured flight data to downstream consumers (API Gateway, PFD, ND, Engine Panel, Tablet Copilot, and Analytics).

---

## Key Features & Constraints

1. **Strict Real Data Integrity (No Fake Data / Жодних Заглушок)**:
   - Values that are missing, unassigned, or unreceived from the simulator are explicitly parsed as `null` (`None`).
   - X-Plane unassigned float sentinels (`-999.0`) are converted to `null` and never defaulted to `0.0` or guessed.
   - Subsystem quality flags (`GOOD`, `STALE`, `NO_SIGNAL`, `NO_DATA`, `ERROR`) provide unambiguous telemetry health to cockpit instruments.

2. **Real Binary X-Plane 11 UDP Parser (`parser.py`)**:
   - Listens on UDP port `49000` for standard X-Plane `DATA` packets (`b'DATA\x00'` followed by 36-byte records `<i8f`).
   - Tracks per-channel timestamps and data freshness.
   - Flags channels as `STALE` if older than `1.0s`, and marks connection `OFFLINE` if no packets arrive for `> 3.0s`.
   - Detects packet gaps, drop bursts, and corrupted payloads.

3. **Authentic Recorded Flight Replayer (`replay.py`)**:
   - Loads real recorded flight telemetry (`data/telemetry_essential.csv`, containing 333 verified data points from a Cessna 172SP flight at UKLL - Lviv International Airport).
   - Packs real rows into authentic X-Plane 11 UDP datagrams and replays them at realistic time deltas.
   - Supports adjustable playback speed (`0.5x`, `1.0x`, `2.0x`) and looping.

4. **FastAPI & AsyncIO Service (`server.py`)**:
   - REST API:
     - `GET /health`: Health probe and connection status.
     - `GET /telemetry/current`: Latest complete aircraft snapshot with strict error metadata.
     - `GET /telemetry/status`: Simulator networking metrics (packet rate Hz, packet loss, drops).
     - `POST /replay/start`: Start authentic flight replay.
     - `POST /replay/stop`: Stop replay.
   - WebSocket:
     - `/ws/telemetry`: High-throughput real-time streaming to Gateway and tablet displays.

5. **Fully Containerized (`Dockerfile`)**:
   - Lightweight Python 3.11-slim container.
   - Exposes `49000/udp` and `8001/tcp`.
   - Bundles verified flight dataset for standalone deployment.

---

## Ports & Architecture

| Port | Protocol | Purpose |
| :--- | :--- | :--- |
| `49000` | UDP | Inbound X-Plane 11 binary telemetry (`DATA`) |
| `8001` | TCP (HTTP/WS) | REST API & WebSocket telemetry streaming |

---

## Directory Structure

```
services/telemetry-service/
├── Dockerfile                  # Container definition (Python 3.11-slim, multi-port)
├── README.md                   # Service documentation & API contract
├── requirements.txt            # Python dependencies (fastapi, uvicorn, pydantic, etc.)
├── config.py                   # Pydantic Settings & environment config
├── models.py                   # Strict data models & quality enums
├── parser.py                   # Real binary X-Plane 11 UDP parser
├── replay.py                   # Real recorded flight data replayer
├── server.py                   # FastAPI application & UDP listener
├── __init__.py                 # Package exports
└── tests/
    ├── __init__.py
    └── test_telemetry.py       # Comprehensive unit and integration test suite
```

---

## Quickstart

### 1. Local Environment Setup

```bash
# Create and activate virtual environment
python -m venv .venv
# On Windows:
.venv\Scripts\activate
# On Linux/macOS:
source .venv/bin/activate

# Install dependencies
pip install -r requirements.txt
```

### 2. Run Tests

```bash
pytest tests/ -v
```

### 3. Run Service

```bash
# Standard mode (listening for live X-Plane on UDP 49000):
python server.py

# Or with Uvicorn:
uvicorn server:app --host 0.0.0.0 --port 8001
```

### 4. Run with Automatic Flight Replay

To test without a running simulator installation, activate authentic replay mode:

```bash
# Set environment variable
set TELEM_REPLAY_MODE=True
python server.py
```

---

## Docker Deployment

Build and run the containerized microservice:

```bash
# Build Docker image
docker build -t at-f3001c-telemetry-service .

# Run container mapping UDP 49000 and HTTP 8001
docker run -d \
  --name telemetry-service \
  -p 49000:49000/udp \
  -p 8001:8001/tcp \
  at-f3001c-telemetry-service
```
