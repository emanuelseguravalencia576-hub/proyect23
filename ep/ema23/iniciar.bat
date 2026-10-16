@echo off
cd /d "%~dp0"
echo ============================================
echo   AJSE Hardware - instalacion y servidor
echo ============================================
python -m pip install -r requirements.txt
if errorlevel 1 (
  echo.
  echo No se pudo instalar Flask. Verifica que Python este instalado y vuelve a intentar.
  pause
  exit /b 1
)
echo.
echo Abre http://127.0.0.1:5000 en tu navegador.
python app.py
pause
