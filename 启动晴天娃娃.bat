@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist "node_modules\electron" (
    echo 正在安装依赖，请稍候...
    call npm install
)
start "" "node_modules\electron\dist\electron.exe" .
exit