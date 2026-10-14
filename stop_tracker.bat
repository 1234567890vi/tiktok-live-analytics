@echo off
chcp 65001 > nul
title إيقاف منصة راصد تيك توك
python "%~dp0control.py" stop
if "%1"=="" pause
