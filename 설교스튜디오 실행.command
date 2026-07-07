#!/bin/bash
# ⛪ 설교 스튜디오 — 맥 실행 파일 (더블클릭으로 실행)
cd "$(dirname "$0")"
URL="http://localhost:8787"

# python3 확인 (맥은 기본 설치되어 있음)
if ! command -v python3 >/dev/null 2>&1; then
  osascript -e 'display alert "Python 3가 필요합니다" message "터미널에서 xcode-select --install 을 실행하거나 python.org에서 설치한 뒤 다시 실행하세요."'
  exit 1
fi

# 이미 실행 중이면 브라우저만 연다
if lsof -iTCP:8787 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "이미 실행 중입니다 — 브라우저를 엽니다."
  open "$URL"
  exit 0
fi

echo "════════════════════════════════════════"
echo "  ⛪ 설교 스튜디오를 시작합니다"
echo "════════════════════════════════════════"

# 서버를 백그라운드로 시작
python3 server.py 8787 &
SERVER_PID=$!

# 서버가 실제로 응답할 때까지 기다렸다가 (최대 15초) 브라우저를 연다
OPENED=0
for i in $(seq 1 30); do
  if curl -s --max-time 1 "$URL" >/dev/null 2>&1; then
    open "$URL"
    OPENED=1
    break
  fi
  if ! kill -0 $SERVER_PID 2>/dev/null; then
    echo "❌ 서버 시작에 실패했습니다. 위의 오류 메시지를 확인하세요."
    read -n1 -p "아무 키나 누르면 닫힙니다..."
    exit 1
  fi
  sleep 0.5
done

if [ "$OPENED" = "1" ]; then
  echo "✅ 브라우저가 열렸습니다: $URL"
else
  echo "⚠ 서버 응답이 늦어 브라우저를 자동으로 열지 못했습니다. 직접 $URL 로 접속하세요."
  open "$URL"
fi
echo "이 창을 닫으면 서버가 종료됩니다."
wait $SERVER_PID
