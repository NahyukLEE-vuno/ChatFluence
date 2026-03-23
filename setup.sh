#!/usr/bin/env bash
set -e

ENV_NAME="chatfluence"
PYTHON_VER="3.11"

echo "========================================"
echo "  ChatFluence 환경 셋업"
echo "========================================"
echo ""

# conda 확인
if ! command -v conda &> /dev/null; then
    echo "[ERROR] conda가 설치되어 있지 않습니다."
    echo "  Miniconda 설치: https://docs.conda.io/en/latest/miniconda.html"
    exit 1
fi

# conda 환경 생성 (이미 있으면 스킵)
if conda info --envs | grep -q "^${ENV_NAME} "; then
    echo "[OK] conda 환경 '${ENV_NAME}'이 이미 존재합니다. 스킵합니다."
else
    echo "[1/3] conda 환경 '${ENV_NAME}' 생성 중 (Python ${PYTHON_VER})..."
    conda create -n "${ENV_NAME}" python="${PYTHON_VER}" -y
fi

# conda 환경 활성화
echo "[2/3] conda 환경 활성화..."
eval "$(conda shell.bash hook)"
conda activate "${ENV_NAME}"

# 의존성 설치
echo "[3/3] Python 패키지 설치 중..."
pip install -r requirements.txt

echo ""
echo "========================================"
echo "  셋업 완료!"
echo "========================================"
echo ""
echo "  실행 방법:"
echo "    conda activate ${ENV_NAME}"
echo "    python server.py"
echo ""
echo "  브라우저에서 http://127.0.0.1:3000 접속"
echo ""
