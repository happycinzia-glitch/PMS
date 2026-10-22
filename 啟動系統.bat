@echo off
chcp 950 >nul
setlocal enableextensions
cd /d "%~dp0"
title 專案管理系統 (本機版)

rem ── 找 Node.js：先看 PATH，找不到再掃常見安裝位置 ──
rem （剛裝好 Node 時，已開啟的視窗還讀不到新的 PATH，所以需要這段備援）
set "NODE_DIR="
where node >nul 2>nul
if not errorlevel 1 goto HAVENODE

if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_DIR=%ProgramFiles%\nodejs"
if defined NODE_DIR goto ADDPATH
if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_DIR=%LOCALAPPDATA%\Programs\nodejs"
if defined NODE_DIR goto ADDPATH
for /f "delims=" %%D in ('dir /b /s "%LOCALAPPDATA%\Microsoft\WinGet\Packages\node.exe" 2^>nul') do set "NODE_DIR=%%~dpD"
if defined NODE_DIR goto ADDPATH
goto NONODE

:ADDPATH
set "PATH=%NODE_DIR%;%PATH%"

:HAVENODE
netstat -ano | findstr /c:":3000 " | findstr /c:"LISTENING" >nul
if not errorlevel 1 goto INUSE

if not exist node_modules goto INSTALL
goto RUN

:INSTALL
echo.
echo   第一次執行，正在安裝相依套件，請稍候...
echo.
call npm install --no-audit --no-fund
if errorlevel 1 goto NPMFAIL
goto RUN

:RUN
echo.
echo   ===============================================
echo     專案管理系統 (本機版) 啟動中
echo     網址：http://localhost:3000/
echo     停止系統：直接關閉這個視窗
echo   ===============================================
echo.
start "" http://localhost:3000/
chcp 65001 >nul
node server.js
chcp 950 >nul
echo.
echo   *** 伺服器已停止 ***
goto END

:INUSE
echo.
echo   連接埠 3000 已經有程式在使用，系統可能已經在執行中。
echo   已為你開啟 http://localhost:3000/
echo.
echo   若瀏覽器打不開畫面，請先關閉舊的系統視窗，再重新執行本檔案。
start "" http://localhost:3000/
goto END

:NONODE
echo.
echo   找不到 Node.js，請先安裝：
echo.
echo       winget install OpenJS.NodeJS.LTS
echo.
echo   安裝完成後請「重新開啟」本檔案，讓系統重新讀取 PATH。
goto END

:NPMFAIL
echo.
echo   相依套件安裝失敗，請確認網路連線後再試一次。
goto END

:END
echo.
pause
