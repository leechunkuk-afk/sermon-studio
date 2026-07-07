@echo off
chcp 65001 >nul
title 설교 스튜디오
cd /d "%~dp0"

rem ⛪ 설교 스튜디오 — 윈도우 실행 파일 (더블클릭으로 실행)

rem 이미 실행 중이면 브라우저만 연다
netstat -an | find ":8787" | find "LISTENING" >nul 2>nul
if not errorlevel 1 (
  echo 이미 실행 중입니다 - 브라우저를 엽니다.
  start "" http://localhost:8787
  exit /b 0
)

rem Python 찾기 (py 런처 우선 - MS스토어 가짜 python 회피)
set PY=
py -3 --version >nul 2>nul
if not errorlevel 1 set PY=py -3
if not defined PY (
  python --version >nul 2>nul
  if not errorlevel 1 set PY=python
)
if not defined PY (
  echo.
  echo [오류] Python 3가 설치되어 있지 않습니다.
  echo https://www.python.org/downloads/ 에서 설치하세요.
  echo 설치할 때 "Add Python to PATH" 체크박스를 꼭 선택하세요.
  echo.
  start "" https://www.python.org/downloads/
  pause
  exit /b 1
)

echo ════════════════════════════════════════
echo   설교 스튜디오를 시작합니다
echo   주소: http://localhost:8787
echo   이 창을 닫으면 서버가 종료됩니다.
echo ════════════════════════════════════════
%PY% server.py 8787 --open
pause
