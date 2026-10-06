@echo off
cd /d "%~dp0"
start "" /b python -m http.server 8765 --bind 127.0.0.1
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:8765"
echo.
echo Keep this window open while using the Sudoku helper.
echo When finished, press any key to close this window and stop the local server.
pause
