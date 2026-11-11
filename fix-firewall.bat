@echo off
REM Opens ports 80 and 443 so people outside your network can reach Caddy.
REM Windows blocks incoming connections by default, which is why the site
REM works on this PC but nowhere else.
REM
REM RIGHT-CLICK this file and choose "Run as administrator".

net session >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo   ============================================
    echo    NOT RUNNING AS ADMINISTRATOR
    echo   ============================================
    echo.
    echo    Close this window, then RIGHT-CLICK
    echo    fix-firewall.bat and choose
    echo    "Run as administrator".
    echo.
    pause
    exit /b 1
)

echo.
echo   Running as administrator - good.
echo.

REM Remove any half-made rules from earlier attempts so this is repeatable.
netsh advfirewall firewall delete rule name="Xenon HTTPS" >nul 2>&1
netsh advfirewall firewall delete rule name="Xenon HTTP"  >nul 2>&1

netsh advfirewall firewall add rule name="Xenon HTTPS" dir=in action=allow protocol=TCP localport=443
netsh advfirewall firewall add rule name="Xenon HTTP"  dir=in action=allow protocol=TCP localport=80

echo.
echo   ============================================
echo    Checking the rules landed...
echo   ============================================
echo.
netsh advfirewall firewall show rule name="Xenon HTTPS" | findstr /C:"Enabled" /C:"LocalPort" /C:"Action"
netsh advfirewall firewall show rule name="Xenon HTTP"  | findstr /C:"Enabled" /C:"LocalPort" /C:"Action"

echo.
echo   Done. Tell Claude it is finished and it will test from outside.
echo.
pause
