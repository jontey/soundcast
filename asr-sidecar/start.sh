#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt

HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-8765}"

exec uvicorn app:app --host "$HOST" --port "$PORT"
