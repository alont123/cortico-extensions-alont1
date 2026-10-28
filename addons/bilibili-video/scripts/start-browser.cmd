@echo off
powershell.exe -NoLogo -NoProfile -File "%~dp0start-browser.ps1" %*
set "BILI_HELPER_EXIT=%ERRORLEVEL%"
if "%~1"=="" pause
exit /b %BILI_HELPER_EXIT%
