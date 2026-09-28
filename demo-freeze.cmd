@echo off
REM The last gate before the demo day
REM Thin wrapper: ExecutionPolicy can block .ps1, not this.
powershell -ExecutionPolicy Bypass -NoProfile -File "%~dp0demo-freeze.ps1" %*
exit /b %ERRORLEVEL%
