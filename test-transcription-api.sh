#!/bin/bash

# Test script for Phase 6: Transcription Control API
# Requires: server running, room 'main' exists, ADMIN_KEY or default 'admin'

API_KEY="${ADMIN_KEY:-admin}"
BASE_URL="http://localhost:3000"
ROOM_SLUG="main"

echo "=== Testing Transcription Control API ==="
echo

# Test 1: Get transcription status (should be empty initially)
echo "Test 1: GET /api/rooms/${ROOM_SLUG}/transcription/status"
curl -s -X GET \
  -H "Authorization: Bearer ${API_KEY}" \
  "${BASE_URL}/api/rooms/${ROOM_SLUG}/transcription/status" | jq .
echo
echo

# Test 2: Try to start transcription (will fail if no active publishers)
echo "Test 2: POST /api/rooms/${ROOM_SLUG}/transcription/start"
curl -s -X POST \
  -H "Authorization: Bearer ${API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"channelName":"default","language":"en"}' \
  "${BASE_URL}/api/rooms/${ROOM_SLUG}/transcription/start" | jq .
echo
echo

# Test 3: Try to stop transcription by channel (will fail if no sessions)
echo "Test 3: POST /api/rooms/${ROOM_SLUG}/transcription/stop"
curl -s -X POST \
  -H "Authorization: Bearer ${API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"channelName":"default"}' \
  "${BASE_URL}/api/rooms/${ROOM_SLUG}/transcription/stop" | jq .
echo
echo

# Test 4: Test with invalid room
echo "Test 4: GET /api/rooms/invalid/transcription/status (should 404)"
curl -s -X GET \
  -H "Authorization: Bearer ${API_KEY}" \
  "${BASE_URL}/api/rooms/invalid/transcription/status" | jq .
echo
echo

# Test 5: Test without auth (should 401)
echo "Test 5: GET without auth (should 401)"
curl -s -X GET \
  "${BASE_URL}/api/rooms/${ROOM_SLUG}/transcription/status" | jq .
echo

echo "=== All tests complete ==="
