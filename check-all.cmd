@echo off
REM Run every automated check (android + 4 relay suites)
REM Thin wrapper: ExecutionPolicy can block .ps1, not this.
powershell -ExecutionPolicy Bypass -NoProfile -File "%~dp0check-all.ps1" %*
exit /b %ERRORLEVEL%
