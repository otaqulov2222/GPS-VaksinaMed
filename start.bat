@echo off
chcp 65001 >nul
title VaksinaMed GPS Monitor
color 0A

echo.
echo  ============================================
echo   VaksinaMed Fleet Control - Kirish tizimi
echo  ============================================
echo.

where python >nul 2>&1
if %errorlevel% neq 0 (
    echo  [XATO] Python topilmadi.
    echo  Login/parol tizimi uchun Python kerak.
    echo  index.html ni to'g'ridan-to'g'ri ochmang — himoya ishlamaydi.
    pause
    goto :done
)

netstat -an | find ":8080" >nul 2>&1
if %errorlevel% equ 0 (
    echo  [XABAR] Port 8080 band - mavjud server ochiladi.
    echo  Yangi login tizimi uchun eski serverni yoping, keyin qayta ishga tushiring.
    echo.
    start "" "http://localhost:8080/login.html"
    goto :done
)

echo  [OK] Python serveri ishga tushirilmoqda...
echo  [OK] Brauzer 3 soniyadan so'ng ochiladi...
echo.
echo  Serverni to'xtatish uchun: Ctrl+C
echo  ============================================
echo.

start /B python "%~dp0server.py" --port 8080 --dir "%~dp0"

timeout /t 3 /nobreak >nul

start "" "http://localhost:8080/login.html"

echo  [OK] Kirish oynasi: http://localhost:8080/login.html
echo  [OK] Admin Pro login: adminpro  (parol: VM_SEED_PASS yoki .env)
echo.
pause >nul

:done
