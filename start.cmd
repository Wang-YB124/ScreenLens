@echo off
setlocal
cd /d "%~dp0"
if not exist "vendor\electron\electron.exe" (
  echo Electron runtime not found. Run build-portable.cmd first.
  pause
  exit /b 1
)
start "" "%~dp0vendor\electron\electron.exe" "%~dp0"
