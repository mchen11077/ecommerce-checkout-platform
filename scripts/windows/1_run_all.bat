@echo off
cd /d "%~dp0..\.."
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\run-claim-experiments.ps1"
echo.
echo Finished. Open results\summary.md
pause
