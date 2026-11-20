@echo off
REM Build and start the AT-F3001C stack (telemetry, analytics, gateway). Output is also written to docker_run.log
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "docker version --format 'Docker engine {{.Server.Version}}' 2>&1 | Tee-Object -FilePath docker_run.log; docker compose up --build -d 2>&1 | Tee-Object -FilePath docker_run.log -Append; ('UP_EXIT=' + $LASTEXITCODE) | Tee-Object -FilePath docker_run.log -Append; docker compose ps 2>&1 | Tee-Object -FilePath docker_run.log -Append"
pause
