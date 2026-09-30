#!/bin/bash

# Soundcast API Test Script
# This script tests the REST API endpoints

API_BASE="http://localhost:3000/api"

echo "Testing Soundcast API"
echo "===================="
echo ""

# Test 1: Create a room
echo "Test 1: Creating a room..."
ROOM_RESPONSE=$(curl -s -X POST $API_BASE/rooms \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Test Conference Room"
  }')

echo "$ROOM_RESPONSE" | jq .
ROOM_SLUG=$(echo "$ROOM_RESPONSE" | jq -r .slug)
echo "Room created with slug: $ROOM_SLUG"
echo ""

# Test 2: Get room details
echo "Test 2: Getting room details..."
curl -s -X GET "$API_BASE/rooms/$ROOM_SLUG" | jq .
echo ""

# Test 3: List all rooms
echo "Test 3: Listing all rooms..."
curl -s -X GET $API_BASE/rooms | jq .
echo ""

# Test 4: Update room
echo "Test 4: Updating room..."
curl -s -X PUT "$API_BASE/rooms/$ROOM_SLUG" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Updated Conference Room"
  }' | jq .
echo ""

# Test 5: Add publisher
echo "Test 5: Adding a publisher..."
PUBLISHER_RESPONSE=$(curl -s -X POST "$API_BASE/rooms/$ROOM_SLUG/publishers" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Maria Rodriguez",
    "channel_name": "es"
  }')

echo "$PUBLISHER_RESPONSE" | jq .
JOIN_TOKEN=$(echo "$PUBLISHER_RESPONSE" | jq -r .join_token)
echo "Publisher created with join token: $JOIN_TOKEN"
echo ""

# Test 6: List publishers
echo "Test 6: Listing publishers..."
curl -s -X GET "$API_BASE/rooms/$ROOM_SLUG/publishers" | jq .
echo ""

echo "===================="
echo "All tests completed!"
echo ""
echo "Summary:"
echo "- Room slug: $ROOM_SLUG"
echo "- Join token: $JOIN_TOKEN"
echo ""
echo "WebSocket endpoints:"
echo "- Listener: ws://localhost:3000/ws/room/$ROOM_SLUG/listen"
echo "- Publisher: ws://localhost:3000/ws/room/$ROOM_SLUG/publish?token=$JOIN_TOKEN"