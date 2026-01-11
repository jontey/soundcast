#!/bin/bash
#
# Whisper.cpp Server Test Script
# Tests the Whisper server with a sample audio file
#

set -e

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  🎙️  Whisper Server Test"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Check if whisper.cpp server exists
if [ ! -f "./whisper.cpp/server" ]; then
  echo "❌ Error: Whisper server not found"
  echo "   Run ./scripts/setup-transcription.sh first"
  exit 1
fi

# Check if model exists
MODEL_PATH="${WHISPER_MODEL_PATH:-./models/ggml-base.bin}"
if [ ! -f "$MODEL_PATH" ]; then
  echo "❌ Error: Model not found: $MODEL_PATH"
  echo "   Run ./scripts/setup-transcription.sh first"
  exit 1
fi

echo "✅ Found whisper server: ./whisper.cpp/server"
echo "✅ Found model: $MODEL_PATH"
echo ""

# Start whisper server in background
echo "🚀 Starting Whisper server on port 8080..."
./whisper.cpp/server -m "$MODEL_PATH" --port 8080 &
WHISPER_PID=$!

# Wait for server to start
sleep 3

# Check if server is running
if ! kill -0 $WHISPER_PID 2>/dev/null; then
  echo "❌ Error: Whisper server failed to start"
  exit 1
fi

echo "✅ Whisper server started (PID: $WHISPER_PID)"
echo ""

# Test with audio file if provided
if [ -n "$1" ] && [ -f "$1" ]; then
  echo "📤 Sending audio file: $1"
  echo ""

  RESPONSE=$(curl -s -X POST http://localhost:8080/inference \
    -H "Content-Type: application/octet-stream" \
    --data-binary "@$1")

  echo "📝 Transcription response:"
  echo "$RESPONSE" | jq '.' 2>/dev/null || echo "$RESPONSE"
  echo ""

  if [ $? -eq 0 ]; then
    echo "✅ Transcription test passed!"
  else
    echo "❌ Transcription test failed"
  fi
else
  echo "ℹ️  No audio file provided for testing"
  echo "   Usage: ./scripts/test-whisper.sh <path-to-wav-file>"
  echo ""
  echo "   The server is running on http://localhost:8080"
  echo "   You can test it with:"
  echo "     curl -X POST http://localhost:8080/inference \\"
  echo "       -H 'Content-Type: application/octet-stream' \\"
  echo "       --data-binary '@your-audio.wav'"
  echo ""
  echo "   Press Ctrl+C to stop the server"
  wait $WHISPER_PID
fi

# Cleanup
echo ""
echo "🛑 Stopping Whisper server..."
kill $WHISPER_PID 2>/dev/null || true
wait $WHISPER_PID 2>/dev/null || true

echo "✅ Test complete"
echo ""
