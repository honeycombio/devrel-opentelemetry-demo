#!/usr/bin/env bash
# Enable the chatbot via the demo-enable endpoint
if [ -z "$CHATBOT_ROOT_URL" ]; then
  echo "Error: CHATBOT_ROOT_URL environment variable is not set"
  exit 1
fi
BASE_URL="$CHATBOT_ROOT_URL"

echo "Enabling chatbot..."
curl -s -X POST "$BASE_URL/chat/demo-enable" \
  -H "Content-Type: application/json" | jq .
