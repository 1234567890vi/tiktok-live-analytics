@echo off
chcp 65001 > nul
title إلغاء التشغيل التلقائي
python "%~dp0control.py" uninstall-startup
if "%1"=="" pause
