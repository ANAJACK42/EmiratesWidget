@echo off
REM Startet das EK050-Widget (Windows)
cd /d "%~dp0"
if not exist node_modules ( call npm install )
call npx electron .
