#!/usr/bin/env bash
# Test script for chatbot enable/disable and question endpoints
if [ -z "$CHATBOT_ROOT_URL" ]; then
  echo "Error: CHATBOT_ROOT_URL environment variable is not set"
  exit 1
fi
BASE_URL="$CHATBOT_ROOT_URL"

echo "=== Enable chatbot ==="
curl -s -X POST "$BASE_URL/chat/demo-enable" \
  -H "Content-Type: application/json" | jq .

echo ""
echo "=== Ask a question (enabled) ==="
curl -s -X POST "$BASE_URL/chat/question" \
  -H "Content-Type: application/json" \
  -d '{"question": "What products do you sell?", "productId": "OLJCESPC7Z"}' | jq .

echo ""
echo "=== Ask an off-topic question (should be refused) ==="
curl -s -X POST "$BASE_URL/chat/question" \
  -H "Content-Type: application/json" \
  -d '{"question": "What is the meaning of life?"}' | jq .

echo ""
echo "=== Disable chatbot ==="
curl -s -X POST "$BASE_URL/chat/demo-disable" \
  -H "Content-Type: application/json" | jq .

echo ""
echo "=== Ask a question (disabled — should be unavailable) ==="
curl -s -X POST "$BASE_URL/chat/question" \
  -H "Content-Type: application/json" \
  -d '{"question": "What products do you sell?"}' | jq .
