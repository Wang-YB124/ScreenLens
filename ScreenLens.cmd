@echo off
cd /d "%~dp0"
if not exist "dist\release\ScreenLens\ScreenLens.exe" (
  echo ScreenLens not found. Build it with:
  echo   powershell -ExecutionPolicy Bypass -File build-release.ps1
  pause
  exit /b 1
)
start "" "%~dp0dist\release\ScreenLens\ScreenLens.exe"
