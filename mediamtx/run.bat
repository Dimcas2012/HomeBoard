@echo off
cd /d "%~dp0"
if not exist mediamtx.exe (
  echo Place mediamtx.exe in this folder. See README.md
  exit /b 1
)
mediamtx.exe mediamtx.yml
