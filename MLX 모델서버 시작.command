#!/bin/bash
# ⛪ 설교 스튜디오 — MLX 모델 서버 도우미 (Apple Silicon 전용)
# HuggingFace의 safetensors 모델을 내려받아 OpenAI 호환 서버(포트 10240)로 띄웁니다.
# 설교 스튜디오에서 백엔드 엔진을 "MLX — mlx-lm (safetensors)"로 선택해 사용하세요.
cd "$(dirname "$0")"

if [[ "$(uname -m)" != "arm64" ]]; then
  echo "이 스크립트는 Apple Silicon(M1/M2/M3/M4) 맥 전용입니다."
  read -n1 -p "아무 키나 누르면 닫힙니다..."
  exit 1
fi

if ! python3 -c "import mlx_lm" >/dev/null 2>&1; then
  echo "mlx-lm이 설치되어 있지 않습니다. (다운로드 약 수백 MB)"
  read -p "지금 설치할까요? (y/N): " yn
  if [[ "$yn" != "y" && "$yn" != "Y" ]]; then exit 0; fi
  python3 -m pip install --user mlx-lm \
    || python3 -m pip install --user --break-system-packages mlx-lm \
    || { echo "설치 실패 — 터미널에서 python3 -m pip install mlx-lm 을 직접 실행해 보세요."; read -n1; exit 1; }
fi

echo "════════════════════════════════════════════════════════"
echo "  HuggingFace 모델 ID를 입력하세요 (mlx-community/... 권장)"
echo "  이 맥(M2 · 8GB RAM)에는 4bit 양자화된 4B급 모델을 권장합니다."
echo "  예) mlx-community/Qwen3-4B-4bit          (한국어 좋음, ~2.3GB)"
echo "      mlx-community/gemma-3-4b-it-4bit     (구글, ~2.6GB)"
echo "      mlx-community/EXAONE-3.5-2.4B-Instruct-4bit (LG 한국어 특화)"
echo "════════════════════════════════════════════════════════"
read -p "모델 [mlx-community/Qwen3-4B-4bit]: " MODEL
MODEL=${MODEL:-mlx-community/Qwen3-4B-4bit}

echo ""
echo "▶ 처음 사용하는 모델은 다운로드(수 GB)에 시간이 걸립니다."
echo "▶ 서버 주소: http://localhost:10240/v1  (이 창을 닫으면 종료)"
echo ""
python3 -m mlx_lm server --model "$MODEL" --port 10240 2>/dev/null \
  || python3 -m mlx_lm.server --model "$MODEL" --port 10240
