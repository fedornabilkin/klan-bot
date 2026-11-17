@echo off
setlocal
cd /d "%~dp0" || exit /b 1
call npm.cmd run check:config
if errorlevel 1 goto failed
call npm.cmd run build
if errorlevel 1 goto failed
call npm.cmd start
if errorlevel 1 goto failed
exit /b 0

:failed
echo Bot startup failed. Install dependencies with npm ci and check your .env configuration.
pause
exit /b 1
