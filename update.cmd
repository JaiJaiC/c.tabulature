@echo off
REM ---------------------------------------------------------------
REM  Double-click this file to publish new tabs.
REM  It runs scripts\update.ps1 with the execution policy bypassed,
REM  then keeps the window open so you can read the output.
REM ---------------------------------------------------------------
chcp 65001 >nul
title Tablature - update library
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\update.ps1"

echo.
echo ---------------------------------------------------------------
pause
