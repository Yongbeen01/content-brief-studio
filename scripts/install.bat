@echo off
setlocal
title Content Brief Studio - install

REM Content Brief Studio installer. Double-click this file.
REM
REM This file stays ASCII: cmd.exe reads .bat in the OEM code page and would
REM mangle anything else. Korean output comes from install.ps1.
REM
REM Clear the "downloaded from the internet" mark on ourselves. Without this a
REM .bat saved from a browser or a chat app may start but is refused permission
REM to launch PowerShell ("Access is denied", code 5).
type nul > "%~f0:Zone.Identifier" 2>nul

set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS%" set "PS=powershell.exe"

echo.
echo   Content Brief Studio
echo   Installing. This window shows the progress.
echo.

"%PS%" -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/Yongbeen01/content-brief-studio/main/scripts/install.ps1 | iex"
set "RC=%ERRORLEVEL%"

echo.
if not "%RC%"=="0" (
  echo   [!] Setup did not finish ^(code %RC%^).
  echo   [!] Take a screenshot of this window and send it to the admin.
) else (
  echo   Done. From now on, use the Content Brief Studio icon on your desktop.
)

echo.
pause
