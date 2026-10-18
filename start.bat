@echo off
setlocal enabledelayedexpansion
title VaxPass Startup Manager
cd /d "%~dp0"

echo ========================================================================
echo                   VAXPASS AUTOMATED STARTUP
echo ========================================================================
echo.

:: 1. Check prerequisites
where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js is not found in PATH.
    echo Please install Node.js 20 or 22 LTS from https://nodejs.org/
    echo.
    pause
    exit /b 1
)

where python >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python 3 is not found in PATH.
    echo Please install Python 3 from https://python.org/ (ensure "Add to PATH" is checked).
    echo.
    pause
    exit /b 1
)

:: 2. Check if Hardhat node is already running on port 8545
echo [1/5] Checking Hardhat blockchain node on port 8545...
powershell -NoProfile -Command "$client = New-Object Net.Sockets.TcpClient; try { $client.Connect('127.0.0.1', 8545); exit 0 } catch { exit 1 } finally { if ($client) { $client.Dispose() } }" >nul 2>&1
if not errorlevel 1 (
    echo       Hardhat node is already running on port 8545.
) else (
    echo       Starting local Hardhat node in a new window...
    start "VaxPass - Blockchain Node (Hardhat)" powershell -NoProfile -NoExit -Command "Set-Location -LiteralPath '%~dp0'; npm run node"
    
    echo       Waiting for JSON-RPC interface to become ready...
    set "NODE_READY="
    for /l %%I in (1,1,30) do (
        powershell -NoProfile -Command "try { $res = Invoke-RestMethod -Uri 'http://127.0.0.1:8545' -Method Post -Body '{\"jsonrpc\":\"2.0\",\"method\":\"eth_blockNumber\",\"params\":[],\"id\":1}' -ContentType 'application/json' -TimeoutSec 1; exit 0 } catch { exit 1 }" >nul 2>&1
        if not errorlevel 1 (
            set "NODE_READY=1"
            goto node_is_ready
        )
        timeout /t 1 /nobreak >nul
    )
    
    if not defined NODE_READY (
        echo.
        echo [ERROR] Hardhat node failed to initialize within 30 seconds.
        echo Please inspect the "VaxPass - Blockchain Node" window for details.
        echo.
        pause
        exit /b 1
    )
)

:node_is_ready
echo       Blockchain node is ready on http://127.0.0.1:8545 (Chain ID: 31337).
echo.

:: 3. Deploy smart contract
echo [2/5] Deploying VaxPass smart contract to local network...
call npm run deploy:local
if errorlevel 1 (
    echo.
    echo [ERROR] Contract deployment failed.
    echo Check console output above for error details.
    echo.
    pause
    exit /b 1
)
echo.

:: 4. Seed demo accounts & batches
echo [3/5] Seeding demo roles and initial vaccine batches (VX001 - VX005)...
call npm run seed:local
if errorlevel 1 (
    echo.
    echo [ERROR] Demo data seeding failed.
    echo Check console output above for error details.
    echo.
    pause
    exit /b 1
)
echo.

:: 5. Check and start frontend HTTP server on port 8080
echo [4/5] Checking frontend web server on port 8080...
powershell -NoProfile -Command "$client = New-Object Net.Sockets.TcpClient; try { $client.Connect('127.0.0.1', 8080); exit 0 } catch { exit 1 } finally { if ($client) { $client.Dispose() } }" >nul 2>&1
if not errorlevel 1 (
    echo       Frontend server is already running on port 8080.
) else (
    echo       Starting Python HTTP server in a new window...
    start "VaxPass - Frontend Server" powershell -NoProfile -NoExit -Command "Set-Location -LiteralPath '%~dp0'; python -m http.server 8080 --bind 0.0.0.0 --directory frontend"
    timeout /t 2 /nobreak >nul
)
echo.

:: 6. Launch browser
echo [5/5] Launching default web browser to http://localhost:8080...
start http://localhost:8080

echo.
echo ========================================================================
echo                      VAXPASS IS NOW RUNNING!
echo ========================================================================
echo.
echo   Local Web App   : http://localhost:8080
for /f "tokens=2 delims=:" %%A in ('ipconfig ^| findstr /R /C:"IPv4 Address" /C:"IPv4 Address. . . . . . . . . . . :"') do (
    set "LAN_IP=%%A"
    set "LAN_IP=!LAN_IP: =!"
    echo   Phone / Wi-Fi   : http://!LAN_IP!:8080
)
echo   Local RPC Node  : http://127.0.0.1:8545 (Chain ID: 31337)
echo.
echo ------------------------------------------------------------------------
echo   DEFAULT DEMO ROLES (Hardhat Accounts #0 to #4):
echo   #0 Regulator   : 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
echo   #1 Manufacturer: 0x70997970C51812dc3A010C7d01b50e0d17dc79C8
echo   #2 Distributor : 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC
echo   #3 Clinic      : 0x90F79bf6EB2c4f870365E785982E1f101E93b906
echo   #4 Logger      : 0x15d34AAf54761d8486467A0b84813589b940e70b
echo ------------------------------------------------------------------------
echo.
echo   * Import any of these development accounts into MetaMask using the
echo     private keys displayed in the "VaxPass - Blockchain Node" window.
echo   * Keep the background Node and Frontend windows open while testing.
echo.
echo Press any key to exit this launcher window (servers will remain running).
pause >nul
endlocal
