@echo off
REM Health check, then open the console fullscreen and paired
REM Thin wrapper: ExecutionPolicy can block .ps1, not this.
powershell -ExecutionPolicy Bypass -NoProfile -File "%~dp0demo-start.ps1" %*
exit /b %ERRORLEVEL%
