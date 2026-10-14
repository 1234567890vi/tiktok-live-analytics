@echo off
chcp 65001 > nul
title تشغيل منصة راصد تيك توك في الخلفية
python "%~dp0control.py" start
if "%1"=="" pause
