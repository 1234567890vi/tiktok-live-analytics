@echo off
chcp 65001 > nul
title حالة منصة راصد تيك توك
python "%~dp0control.py" status
if "%1"=="" pause
