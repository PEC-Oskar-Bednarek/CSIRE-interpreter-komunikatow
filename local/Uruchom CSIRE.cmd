@echo off
setlocal
"%~dp0python\python.exe" -B "%~dp0serve.py" --port 0 --open %*
if errorlevel 1 pause
