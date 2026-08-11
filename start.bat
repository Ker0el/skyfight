@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

REM ============================================================
REM  Sky Fight - 多人联网开飞机  Windows 一键启动脚本
REM  使用方式：双击 start.bat
REM ============================================================

title Sky Fight - 启动器
cd /d "%~dp0"

echo.
echo ╔══════════════════════════════════════════════════════╗
echo ║    Sky Fight - 多人联网开飞机                         ║
echo ╚══════════════════════════════════════════════════════╝
echo.

REM ------------------------------------------------------------
REM  Step 1: 检测 Node.js / npm
REM ------------------------------------------------------------
echo [1/5] 检测 Node.js 环境...
where node >nul 2>nul
if errorlevel 1 (
    echo.
    echo [ERROR] 未检测到 Node.js！请先安装 Node.js 14 以上版本。
    echo         下载地址：https://nodejs.org/zh-cn/download/
    echo.
    goto :fail
)
where npm >nul 2>nul
if errorlevel 1 (
    echo.
    echo [ERROR] 未检测到 npm，可能 Node.js 安装不完整，请重装 Node.js。
    goto :fail
)
for /f "delims=" %%v in ('node -v') do set NODE_VER=%%v
for /f "delims=" %%v in ('npm -v') do set NPM_VER=%%v
echo         OK  node %NODE_VER%   npm %NPM_VER%
echo.

REM ------------------------------------------------------------
REM  Step 2: 检测 8080 端口是否被占用
REM ------------------------------------------------------------
echo [2/5] 检测 8080 端口...
netstat -ano | findstr ":8080 " | findstr "LISTENING" >nul
if not errorlevel 1 (
    echo.
    echo [WARN]  8080 端口已被占用，脚本将尝试帮您关闭占用进程。
    for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":8080 " ^| findstr "LISTENING"') do (
        echo         PID=%%p  正在终止...
        taskkill /F /PID %%p >nul 2>nul
    )
    timeout /t 1 /nobreak >nul
    netstat -ano | findstr ":8080 " | findstr "LISTENING" >nul
    if not errorlevel 1 (
        echo [ERROR] 仍无法释放 8080 端口，请手动关闭占用程序后重试。
        goto :fail
    )
) else (
    echo         OK  8080 端口可用
)
echo.

REM ------------------------------------------------------------
REM  Step 3: 安装依赖（仅当 node_modules 不存在时）
REM ------------------------------------------------------------
echo [3/5] 安装依赖 ws...
if not exist "node_modules\ws\" (
    echo         首次启动，正在执行 npm install ...
    call npm install --no-audit --no-fund --loglevel=error
    if errorlevel 1 (
        echo [ERROR] npm install 失败，请检查网络或手动执行: npm install
        goto :fail
    )
) else (
    echo         已存在，跳过
)
echo.

REM ------------------------------------------------------------
REM  Step 4: 启动服务器（后台子进程，保持当前窗口输出日志）
REM ------------------------------------------------------------
echo [4/5] 启动 Sky Fight 服务器...
echo.
echo         服务端地址: http://localhost:8080
echo         WebSocket: ws://localhost:8080/ws
echo.
echo         打开两个浏览器窗口访问上面的地址，输入不同名字即可联机对打。
echo         操作: WASD 移动 / 鼠标瞄准 / 空格或左键射击 / Enter 切换聊天
echo.
echo         按 Ctrl+C 可停止服务。
echo.
echo ────────────────────────────────────────────────────────────

REM 先尝试用默认浏览器打开页面（延迟 3 秒，避免服务未起来）
start "" cmd /c "timeout /t 3 /nobreak >nul & start http://localhost:8080/"

REM 最后一步：启动服务器（前台运行，输出日志到此窗口）
call npm start
if errorlevel 1 (
    echo.
    echo [ERROR] 服务器异常退出，错误码 %errorlevel%
    echo         常见原因:
echo           1) 8080 端口被其它安全软件占用
echo           2) Node.js 权限不足，尝试用管理员身份运行
echo           3) ws 模块未装好，尝试删除 node_modules 后重新双击本脚本
    goto :fail
)

goto :eof

:fail
echo.
pause
exit /b 1
