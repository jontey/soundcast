#!/bin/bash

# Soundcast Multi-Tenant API Test Script
# This script tests the REST API endpoints

API_BASE="http://localhost:3000/api"
API_KEY="test-api-key-123"

echo "🧪 Testing Soundcast Multi-Tenant API"
echo "======================================"
echo ""

# Test 1: Create a room
echo "📝 Test 1: Creating a room..."
ROOM_RESPONSE=$(curl -s -X POST $API_BASE/rooms \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Test Conference Room",
    "is_local_only": false,
    "sfu_url": "ws://localhost:3000/ws",
    "coturn_config_json": "[{\"urls\": \"stun:stun.l.google.com:19302\"}]"
  }')

echo "$ROOM_RESPONSE" | jq .
ROOM_SLUG=$(echo "$ROOM_RESPONSE" | jq -r .slug)
echo "✅ Room created with slug: $ROOM_SLUG"
echo ""

# Test 2: Get room details
echo "📝 Test 2: Getting room details..."
curl -s -X GET "$API_BASE/rooms/$ROOM_SLUG" \
  -H "Authorization: Bearer $API_KEY" | jq .
echo ""

# Test 3: List all rooms
echo "📝 Test 3: Listing all rooms..."
curl -s -X GET $API_BASE/rooms \
  -H "Authorization: Bearer $API_KEY" | jq .
echo ""

# Test 4: Update room
echo "📝 Test 4: Updating room..."
curl -s -X PUT "$API_BASE/rooms/$ROOM_SLUG" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Updated Conference Room",
    "is_local_only": true,
    "sfu_url": "ws://192.168.1.100:8080/ws",
    "coturn_config_json": "[{\"urls\": \"turn:turn.example.com:3478\", \"username\": \"user\", \"credential\": \"pass\"}]"
  }' | jq .
echo ""

# Test 5: Add interpreter
echo "📝 Test 5: Adding an interpreter..."
INTERPRETER_RESPONSE=$(curl -s -X POST "$API_BASE/rooms/$ROOM_SLUG/interpreters" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Maria Rodriguez",
    "target_language": "es"
  }')

echo "$INTERPRETER_RESPONSE" | jq .
JOIN_TOKEN=$(echo "$INTERPRETER_RESPONSE" | jq -r .join_token)
echo "✅ Interpreter created with join token: $JOIN_TOKEN"
echo ""

# Test 6: List interpreters
echo "📝 Test 6: Listing interpreters..."
curl -s -X GET "$API_BASE/rooms/$ROOM_SLUG/interpreters" \
  -H "Authorization: Bearer $API_KEY" | jq .
echo ""

# Test 7: Test authentication (invalid API key)
echo "📝 Test 7: Testing invalid API key..."
curl -s -X GET $API_BASE/rooms \
  -H "Authorization: Bearer invalid-key" | jq .
echo ""

# Test 8: Test missing authorization
echo "📝 Test 8: Testing missing authorization..."
curl -s -X GET $API_BASE/rooms | jq .
echo ""

echo "======================================"
echo "✅ All tests completed!"
echo ""
echo "Summary:"
echo "- Room slug: $ROOM_SLUG"
echo "- Join token: $JOIN_TOKEN"
echo ""
echo "WebSocket endpoints:"
echo "- Listener: ws://localhost:3000/ws/room/$ROOM_SLUG/listen"
echo "- Interpreter: ws://localhost:3000/ws/room/$ROOM_SLUG/interpret?token=$JOIN_TOKEN"
