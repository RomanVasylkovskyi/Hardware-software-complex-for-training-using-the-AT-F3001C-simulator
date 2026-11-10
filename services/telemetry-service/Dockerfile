# ==============================================================================
# Dockerfile for AT-F3001C Telemetry Microservice
# ==============================================================================
# Base image: Official lightweight Python 3.11 Slim
FROM python:3.11-slim AS base

# System optimization environment variables
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    TELEM_HTTP_HOST=0.0.0.0 \
    TELEM_HTTP_PORT=8001 \
    TELEM_UDP_HOST=0.0.0.0 \
    TELEM_UDP_PORT=49000

# Create application working directory and non-root user
WORKDIR /app

# Install security and performance dependencies
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd -u 10001 -m -s /bin/sh appuser

# Install Python requirements
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy service source code
COPY config.py models.py parser.py replay.py server.py __init__.py ./

# Create data directory and copy flight data for self-contained replay mode
RUN mkdir -p /app/data
COPY data/telemetry_essential.csv /app/data/telemetry_essential.csv

# Set ownership to non-root user
RUN chown -R appuser:appuser /app

# Switch to non-root user
USER appuser

# Expose X-Plane 11 UDP input and HTTP/WebSocket output
EXPOSE 49000/udp
EXPOSE 8001/tcp

# Healthcheck validating the service REST API
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
    CMD python -c "import urllib.request; sys_exit = 0 if urllib.request.urlopen('http://localhost:8001/health').getcode() == 200 else 1; exit(sys_exit)"

# Default entrypoint
CMD ["python", "server.py"]
