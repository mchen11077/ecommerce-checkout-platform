@echo off
REM Start the API first with docker compose up -d --build.
cd /d "%~dp0..\.."

where pnpm >nul 2>&1
if errorlevel 1 (
  echo pnpm not found. Install it with: corepack enable
  pause
  exit /b 1
)

if not exist "coupon-client\dist\index.js" (
  echo Building the typed client first...
  call pnpm --dir coupon-client install --no-frozen-lockfile
  if errorlevel 1 exit /b 1
  call pnpm --dir coupon-client build
  if errorlevel 1 exit /b 1
)

if not exist "coupon-web\node_modules" (
  call pnpm --dir coupon-web install --no-frozen-lockfile
  if errorlevel 1 exit /b 1
)

echo Front end: http://localhost:5173
call pnpm --dir coupon-web dev
pause
