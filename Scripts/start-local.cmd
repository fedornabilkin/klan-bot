@echo off
setlocal
node "%~dp0prepare-local.mjs"
if errorlevel 1 goto failed
cd /d "%~dp0..\Project" || exit /b 1
if not exist "node_modules\tsx\package.json" (
  call npm.cmd ci
  if errorlevel 1 goto failed
)
call npm.cmd run check:config
if errorlevel 1 goto failed
call npm.cmd run build
if errorlevel 1 goto failed
call npm.cmd start
if errorlevel 1 goto failed
exit /b 0

:failed
echo Bot startup failed. Check Project\.env and the messages above.
pause
exit /b 1
