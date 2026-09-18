@echo off
title MoInk 一键刷机
cd /d "%~dp0"

echo ================================================
echo   墨印 MoInk 一键刷机（整包 merged.bin @ 0x0）
echo ================================================
echo.

rem ---------- 1. 找 Python（python 优先，其次 py / python3） ----------
set "PY="
python --version >nul 2>&1
if not errorlevel 1 set "PY=python"
if not defined PY (
    py --version >nul 2>&1
    if not errorlevel 1 set "PY=py"
)
if not defined PY (
    python3 --version >nul 2>&1
    if not errorlevel 1 set "PY=python3"
)
if not defined PY (
    echo [错误] 这台电脑没有可用的 Python 命令。
    echo        请安装 Python 3.8 以上：https://www.python.org/downloads/
    echo        安装时务必勾选 "Add python.exe to PATH"，装完重新双击本脚本。
    echo.
    pause
    exit /b 1
)
echo [1/3] Python 已找到，使用命令：%PY%

rem ---------- 2. 依赖检查 / 自动安装 esptool ----------
%PY% -c "import esptool, serial" >nul 2>&1
if errorlevel 1 (
    echo [2/3] 缺少 esptool，正在自动安装（需要联网，仅第一次）...
    %PY% -m pip install --upgrade esptool
    if errorlevel 1 (
        echo [错误] pip 安装失败。请检查网络后重试，或手动执行：
        echo        %PY% -m pip install esptool
        echo.
        pause
        exit /b 1
    )
) else (
    echo [2/3] esptool 已就绪。
)

rem ---------- 3. 刷机 ----------
echo [3/3] 开始刷机（自动选择串口，跳过无 VID 的虚拟口）...
echo.
%PY% flash_on_pc.py %*
set RC=%ERRORLEVEL%
echo.
if "%RC%"=="0" (
    echo 刷机成功。可以关闭本窗口，去手机上连热点 MoInk-XXXX 了。
) else (
    echo 刷机失败。快捷排查：
    echo   1. 拔插一次 USB 线，重新双击本脚本
    echo   2. 打开命令行进入本目录，运行：python flash_on_pc.py --no-stub
    echo   3. 换一根能传数据的 USB 线；确认设备管理器里有串口设备
)
echo.
pause
exit /b %RC%
