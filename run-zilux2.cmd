@echo off
rem Double-click launcher for the Zilux2 source tree.
rem Uses the published portable build when present; otherwise builds it first.
setlocal
set "ROOT=%~dp0"
set "EXE=%ROOT%dist\Zilux2\Zilux2.exe"

if not exist "%EXE%" (
  echo Zilux2: first run, building the portable app...
  powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%tools\publish.ps1"
  if errorlevel 1 (
    echo.
    echo Build failed. See the messages above.
    pause
    exit /b 1
  )
)

start "" "%EXE%"
exit /b 0
