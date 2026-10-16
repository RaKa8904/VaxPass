@echo off
setlocal
cd /d "%~dp0"

echo Starting VaxPass local blockchain...
start "VaxPass - Hardhat node" powershell -NoProfile -NoExit -Command "Set-Location -LiteralPath '%~dp0'; npm run node"

echo Waiting for Hardhat RPC on port 8545...
set "RPC_READY="
for /l %%I in (1,1,30) do (
	powershell -NoProfile -Command "$client = New-Object Net.Sockets.TcpClient; try { $client.Connect('127.0.0.1',8545); exit 0 } catch { exit 1 } finally { if ($client) { $client.Dispose() } }" >nul 2>&1
	if not errorlevel 1 (
		set "RPC_READY=1"
		goto rpc_ready
	)
	timeout /t 1 /nobreak >nul
)

if not defined RPC_READY (
	echo.
	echo ERROR: Hardhat did not open port 8545.
	echo Check the VaxPass - Hardhat node window for the error.
	pause
	exit /b 1
)

:rpc_ready
echo Hardhat RPC is ready.

echo Deploying and seeding demo data...
call npm run deploy:local
if errorlevel 1 (
	echo.
	echo ERROR: Contract deployment failed.
	pause
	exit /b 1
)
call npm run seed:local
if errorlevel 1 (
	echo.
	echo ERROR: Demo data seeding failed.
	pause
	exit /b 1
)

echo Starting VaxPass frontend...
start "VaxPass - Frontend" powershell -NoProfile -NoExit -Command "Set-Location -LiteralPath '%~dp0'; python -m http.server 8080 --bind 0.0.0.0 --directory frontend"

echo.
echo VaxPass is starting.
echo Computer: http://localhost:8080
for /f "tokens=2 delims=:" %%A in ('ipconfig ^| findstr /R /C:"IPv4 Address" /C:"IPv4 Address. . . . . . . . . . . :"') do echo Phone URL: http://%%A:8080
 echo.
echo Keep the Hardhat and frontend windows open.
pause
endlocal
