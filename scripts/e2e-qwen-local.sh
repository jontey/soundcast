#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

SERVER_LOG="${ROOT_DIR}/output/playwright/qwen-local-server.log"
mkdir -p "${ROOT_DIR}/output/playwright"

cleanup() {
  if [[ -n "${SERVER_PID:-}" ]] && kill -0 "${SERVER_PID}" >/dev/null 2>&1; then
    kill "${SERVER_PID}" >/dev/null 2>&1 || true
    wait "${SERVER_PID}" 2>/dev/null || true
  fi
}
trap cleanup EXIT

export ANNOUNCED_IP=127.0.0.1
export TRANSCRIPTION_MODE=qwen
export QWEN_ASR_BIN=./tmp/qwen-asr/qwen_asr
export QWEN_ASR_MODEL_DIR=./tmp/qwen-asr/qwen3-asr-0.6b
export QWEN_ASR_TIMEOUT_MS=60000
export TRANSCRIPTION_CHUNK_SECONDS=1
export TRANSCRIPTION_CHUNK_OVERLAP_SECONDS=0.2
export QWEN_ASR_FFMPEG_RESTART_MAX_ATTEMPTS=5
export QWEN_ASR_FFMPEG_RESTART_DELAY_MS=500
export QWEN_ASR_FIRST_AUDIO_TIMEOUT_MS=8000
unset QWEN_ASR_TEST_TEXT

echo "[e2e-qwen-local] starting server (logs: ${SERVER_LOG})"
node src/server.js >"${SERVER_LOG}" 2>&1 &
SERVER_PID=$!

echo "[e2e-qwen-local] waiting for http://127.0.0.1:3000"
for _ in {1..40}; do
  if curl -sf "http://127.0.0.1:3000/api/config" >/dev/null; then
    break
  fi
  sleep 0.5
done

if ! curl -sf "http://127.0.0.1:3000/api/config" >/dev/null; then
  echo "[e2e-qwen-local] server did not become ready"
  exit 1
fi

echo "[e2e-qwen-local] running frontend e2e"
node output/playwright/e2e-qwen-admin-injected-audio.mjs

echo "[e2e-qwen-local] latest transcripts for room qwen-local-e2e-6"
sqlite3 soundcast.db \
  "select id, channel_name, text_content, datetime(timestamp_start,'unixepoch') \
   from transcripts where room_id=(select id from rooms where slug='qwen-local-e2e-6') \
   order by id desc limit 8;"

echo "[e2e-qwen-local] success"
