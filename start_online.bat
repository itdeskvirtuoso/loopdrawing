@echo off
cd /d "%~dp0"
title Loop Drawings - online (close this window to stop)
where python >nul 2>nul || (echo Python is not installed. Install Python 3 from python.org and try again.& pause & exit /b 1)
python -c "import pymupdf, openpyxl, ezdxf" 2>nul || python -m pip install -r requirements.txt
python online.py
pause
