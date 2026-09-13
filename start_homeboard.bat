@echo off
REM HomeBoard: Redis + HTTPS (потрібно для камери на iPhone)
cd /d "%~dp0"

start "HomeBoard-Redis" cmd /k "tools\redis\bin\redis-server.exe tools\redis\bin\redis.windows.conf --port 6380"
timeout /t 2 >nul
call .venv\Scripts\activate.bat
python manage.py runssl --addr 10.1.10.123 --port 8007
