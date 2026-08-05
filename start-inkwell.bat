@echo off
REM ============================================================
REM  Inkwell  -  one double-click to get writing.
REM
REM  Starts Ollama if it isn't already serving, installs
REM  dependencies the first time, starts Inkwell, and opens your
REM  browser once the app is actually answering.
REM
REM  Close this window to stop Inkwell.
REM  Ollama keeps running in its own minimised window.
REM ============================================================

setlocal EnableExtensions

REM This script re-runs itself with this flag to open the browser at the
REM right moment, so there's only one file to keep.
if /i "%~1"=="--open-when-ready" goto :open_when_ready

REM Work from the folder this file lives in, so double-clicking works.
cd /d "%~dp0"
title Inkwell

echo.
echo   Inkwell  -  your local AI writing studio
echo   ------------------------------------------------
echo.

REM ---- Node -------------------------------------------------
where node >nul 2>nul
if errorlevel 1 (
  echo   [X] Node.js isn't installed, or isn't on PATH.
  echo       Install it from https://nodejs.org
  echo       then close this window and run this file again.
  echo.
  pause
  exit /b 1
)

REM ---- dependencies, first run only -------------------------
if not exist "node_modules\" (
  echo   First run - installing dependencies. This takes a minute.
  echo.
  call npm install
  if errorlevel 1 (
    echo.
    echo   [X] npm install failed. The reason is above.
    echo.
    pause
    exit /b 1
  )
  echo.
)

REM ---- Ollama -----------------------------------------------
curl.exe -s -o nul --max-time 2 http://127.0.0.1:11434
if errorlevel 1 (
  where ollama >nul 2>nul
  if errorlevel 1 (
    echo   [X] Ollama isn't installed, or isn't on PATH.
    echo       Install it from https://ollama.com/download
    echo.
    pause
    exit /b 1
  )
  echo   Ollama isn't running - starting it...
  start "Ollama" /min cmd /c ollama serve
  set OLLAMA_UP=
  for /l %%i in (1,1,30) do (
    if not defined OLLAMA_UP (
      curl.exe -s -o nul --max-time 2 http://127.0.0.1:11434 && set OLLAMA_UP=1
      if not defined OLLAMA_UP timeout /t 1 /nobreak >nul
    )
  )
  if defined OLLAMA_UP (
    echo   Ollama is up.
  ) else (
    echo   [!] Ollama didn't answer within 30 seconds.
    echo       Inkwell will start anyway - Settings will say what's wrong.
  )
) else (
  echo   Ollama is already running.
)

REM ---- open the browser once Inkwell answers ----------------
start "" /b cmd /c call "%~f0" --open-when-ready

REM ---- Inkwell ----------------------------------------------
echo.
echo   Starting Inkwell. Close this window to stop it.
echo   ------------------------------------------------
echo.
call npm start
goto :eof


REM ============================================================
REM  Poll until the app responds, then open it. Beats guessing a
REM  delay, which is always wrong on the first run.
REM ============================================================
:open_when_ready
for /l %%i in (1,1,60) do (
  curl.exe -s -o nul --max-time 2 http://127.0.0.1:4321 && (
    start "" http://localhost:4321
    exit /b 0
  )
  timeout /t 1 /nobreak >nul
)
exit /b 0
