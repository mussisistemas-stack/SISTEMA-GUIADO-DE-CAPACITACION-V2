@echo off
title Sistema de Capacitacion - Front Retail
cd /d "%~dp0"

echo ============================================
echo   Sistema de Capacitacion de Front Retail
echo   Iniciando servidor local...
echo ============================================
echo.

if not exist "node_modules" (
    echo Instalando dependencias por primera vez, por favor espera...
    call npm install
    echo.
)

start "" http://localhost:5500

call npm start

pause
