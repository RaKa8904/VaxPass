@echo off
setlocal
cd /d "%~dp0"

echo Starting VaxPass local blockchain...
start "VaxPass - Hardhat node" powershell -NoExit -Command "Set-Location -LiteralPath '%~dp0'; npm run node"

timeout /t 4 /nobreak >nul

echo Deploying and seeding demo data...
start "VaxPass - Deploy and seed" powershell -NoExit -Command "Set-Location -LiteralPath '%~dp0'; npm run deploy:local; if ($LASTEXITCODE -eq 0) { npm run seed:local }"

timeout /t 3 /nobreak >nul

echo Starting VaxPass frontend...
start "VaxPass - Frontend" powershell -NoExit -Command "Set-Location -LiteralPath '%~dp0'; python -m http.server 8080 --bind 0.0.0.0 --directory frontend"

echo.
echo VaxPass is starting.
echo Computer: http://localhost:8080
for /f "tokens=2 delims=:" %%A in ('ipconfig ^| findstr /R /C:"IPv4 Address" /C:"IPv4 Address. . . . . . . . . . . :"') do echo Phone URL: http://%%A:8080
 echo.
echo Keep the Hardhat and frontend windows open.
pause
endlocal
