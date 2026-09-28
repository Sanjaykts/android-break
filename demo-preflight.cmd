@echo off
REM Red/green checks before walking on stage
REM Thin wrapper: ExecutionPolicy can block .ps1, not this.
powershell -ExecutionPolicy Bypass -NoProfile -File "%~dp0demo-preflight.ps1" %*
exit /b %ERRORLEVEL%
