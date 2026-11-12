@echo off
chcp 65001 >nul
title Sistema de Capacitacion - Front Retail - Puerto 3006
cd /d "%~dp0"

echo ==================================================
echo   SISTEMA DE CAPACITACION - FRONT RETAIL MUSSI
echo   Configuracion para Red Local y Red Externa
echo ==================================================
echo.

node --version >nul 2>&1
if errorlevel 1 (
    echo ERROR: Node.js no esta instalado o no esta en el PATH.
    echo Por favor instala Node.js desde https://nodejs.org
    echo.
    pause
    exit /b 1
)

if not exist "node_modules" (
    echo Instalando dependencias por primera vez, por favor espera...
    call npm install
    echo.
)

set PORT=3006
set HOST=0.0.0.0
set EXTERNAL_IP=186.81.6.227
set OPEN_BROWSER=1

echo ==================================================
echo   CONFIGURACION DE RED
echo ==================================================
echo   Puerto:           3006
echo   Host:             0.0.0.0 - Todas las interfaces
echo   URL Red Externa:  http://186.81.6.227:3006/
echo   URL Local:        http://localhost:3006/
echo ==================================================
echo   Iniciando servidor... No cierres esta ventana.
echo ==================================================

node server.js

echo.
echo Servidor detenido.
pause
