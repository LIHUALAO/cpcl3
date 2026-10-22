@echo off
setlocal EnableExtensions EnableDelayedExpansion

rem ============================================================
rem  PCL3 launcher - one click start
rem  (comments in English to avoid cmd codepage issues;
rem   user-visible text is Chinese, file is GBK encoded)
rem ============================================================

title PCL3
color 0A

set "SCRIPT_DIR=%~dp0"
set "PORT=%~1"
if "%PORT%"=="" set "PORT=37421"

cd /d "%SCRIPT_DIR%"

echo.
echo   ==============================================
echo      PCL3  Minecraft 启动器
echo   ==============================================
echo.

rem ---- 1. locate node.exe ----
set "NODE_EXE="
for %%N in (node.exe) do if not "%%~$PATH:N"=="" set "NODE_EXE=%%~$PATH:N"
if not defined NODE_EXE if exist "%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" set "NODE_EXE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_EXE goto no_node

echo   Node: %NODE_EXE%

rem ---- 2. build if needed ----
if not exist "dist\cli\index.js" goto do_build
if not exist "dist\web\public\index.html" goto do_build
goto run

:do_build
echo.
echo   [构建] 首次运行，正在准备文件...
echo.
if exist "node_modules\typescript\bin\tsc" goto compile
echo   [构建] 正在安装依赖（国内镜像，可能需要几分钟）...
where pnpm >nul 2>nul
if errorlevel 1 goto use_npm
call pnpm install --registry=https://registry.npmmirror.com
if errorlevel 1 goto dep_fail
goto compile
:use_npm
call npm install --registry=https://registry.npmmirror.com
if errorlevel 1 goto dep_fail
:compile
"%NODE_EXE%" node_modules\typescript\bin\tsc -p tsconfig.build.json
if errorlevel 1 goto build_fail
"%NODE_EXE%" scripts\copy-web-assets.mjs
if errorlevel 1 goto build_fail
echo.
echo   [构建] 完成。
echo.

:run
echo   正在启动:  http://127.0.0.1:%PORT%
echo.
echo   ------------------------------------------------
echo     关闭这个窗口即可退出 PCL3
echo   ------------------------------------------------
echo.
start "" /b cmd /c "timeout /t 3 >nul & start http://127.0.0.1:%PORT%/"
"%NODE_EXE%" dist\cli\index.js web --port %PORT%
if errorlevel 1 goto run_fail
echo.
echo   已退出。
goto end

:no_node
color 0C
echo.
echo   [错误] 找不到 Node.js
echo.
echo   PCL3 需要 Node.js 22 或更新版本。
echo   请安装后重试：
echo.
echo     国内镜像  https://npmmirror.com/mirrors/node/
echo     官方网站  https://nodejs.org/
echo.
echo   已有便携版？把它放进 PATH，或改本文件的 NODE_EXE 查找行。
echo.
pause
exit /b 1

:dep_fail
color 0C
echo.
echo   [错误] 依赖安装失败。
echo   请手动执行:  npm install --registry=https://registry.npmmirror.com
echo.
pause
exit /b 1

:build_fail
color 0C
echo.
echo   [错误] 构建失败，请检查上面的报错。
echo.
pause
exit /b 1

:run_fail
color 0C
echo.
echo   服务异常退出。
echo.
echo   常见原因:
echo     - 端口 %PORT% 被占用，换一个:  start-pcl3.bat 40000
echo     - Node 版本太旧 (需要 22+)
echo.
pause
exit /b 1

:end
endlocal
