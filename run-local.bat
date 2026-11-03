@echo off
chcp 65001 >nul
cd /d "%~dp0"
title PDF 편집기 서버 - 편집하는 동안 닫지 마세요
echo PDF 편집기를 http://localhost:8765 에서 실행합니다.
echo [중요] 편집하는 동안 이 창을 닫지 마세요. 닫으면 PDF 열기와 저장이 안 됩니다.
start "" http://localhost:8765/
python serve.py 8765
