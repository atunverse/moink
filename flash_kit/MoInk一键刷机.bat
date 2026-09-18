@echo off
title MoInk 一键刷机
cd /d "%~dp0"
setlocal enableDelayedExpansion
set /a tried=0

rem ========== 1. 找 Python（python 优先，其次 py / python3） ==========
:checkpy
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
if defined PY goto foundpy

if !tried! lss 1 (
    set /a tried=!tried!+1
    goto askinstall
)
echo.
echo [错误] Python 未能就绪（未授权安装或安装失败）。
echo        可手动安装：https://www.python.org/downloads/windows/
echo        安装时务必勾选 "Add python.exe to PATH"，装完重新双击本脚本。
echo.
pause
exit /b 1

:askinstall
echo.
echo [提示] 这台电脑没有找到可用的 Python 3。
echo        是否现在自动下载并安装？需要联网，约 25 MB，装到当前用户目录。
set /p "ans=输入 y 回车 = 自动安装，其他键 = 退出并显示手动安装方法："
if /i "!ans!"=="y" goto installpy
set /a tried=!tried!+1
goto checkpy

:installpy
echo.
echo [安装] 正在从 python.org 获取最新 Python 3 版本号...
set "release="
for /f "usebackq delims=" %%x in (`powershell -command "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; $c=(Invoke-WebRequest -UseBasicParsing 'https://www.python.org/downloads/windows/').Content; if($c -match 'Latest Python 3 Release.*?python-(\d+)/'){$v=$Matches[1]; Write-Output ($v.Substring(0,1)+'.'+$v.Substring(1,2)+'.'+$v.Substring(3))}" 2^>nul`) do set "release=%%x"
if not defined release (
    echo [安装] 未能解析最新版本号，改用固定版本 3.12.10。
    set "release=3.12.10"
)
echo [安装] 目标版本 Python !release!，开始下载官方安装包...
set "url=https://www.python.org/ftp/python/!release!/python-!release!-amd64.exe"
powershell -command "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; (new-object System.Net.WebClient).DownloadFile('!url!','%TEMP%\moink_pyinstall.exe')" >nul 2>&1
if not exist "%TEMP%\moink_pyinstall.exe" (
    echo [错误] 安装包下载失败，请检查网络后重新运行本脚本。
    set /a tried=!tried!+1
    goto checkpy
)
echo [安装] 正在静默安装，约 1 分钟，装完自动继续...
pushd "%TEMP%"
moink_pyinstall.exe /quiet PrependPath=1 Include_test=0 Shortcuts=0 Include_launcher=0
popd
del "%TEMP%\moink_pyinstall.exe" >nul 2>&1
call :updatepath
echo [安装] 安装完成，重新检测 Python...
goto checkpy

:updatepath
rem 静默安装后 PATH 不会立即在本窗口生效，从注册表重读一次
set "upath="
set "spath="
for /f "tokens=2*" %%i in ('reg.exe query "HKCU\Environment" /v "Path" 2^>nul') do set "upath=%%j"
for /f "tokens=2*" %%i in ('reg.exe query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v "Path" 2^>nul') do set "spath=%%j"
if defined spath set "PATH=%spath%"
if defined upath set "PATH=%PATH%;%upath%"
goto :eof

:foundpy
echo [1/3] Python 已找到，使用命令：%PY%

rem ========== 2. 依赖检查 / 自动安装 esptool ==========
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

rem ========== 3. 刷机 ==========
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
