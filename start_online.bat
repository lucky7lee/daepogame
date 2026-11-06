@echo off
chcp 65001 >nul
title DAEPO FORTRESS Online Server & Tunnel
echo ========================================================
echo 💣 Starting DAEPO FORTRESS Server & Online Tunnel...
echo ========================================================
start "DAEPO Local Server" cmd /k "node "%~dp0server.js""
timeout /t 2 >nul
echo.
echo 🌐 Open the https://xxxx.lhr.life URL below on your Smartphone or PC!
echo ========================================================
ssh -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30 -R 80:localhost:3020 nokey@localhost.run
pause
