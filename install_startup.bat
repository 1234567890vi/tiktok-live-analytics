@echo off
chcp 65001 > nul
title تثبيت التشغيل التلقائي مع إقلاع ويندوز
python "%~dp0control.py" install-startup
if "%1"=="" pause
