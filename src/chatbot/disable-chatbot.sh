#!/usr/bin/env bash
# Disable the chatbot via the demo-disable endpoint
if [ -z "$CHATBOT_ROOT_URL" ]; then
  echo "Error: CHATBOT_ROOT_URL environment variable is not set"
  exit 1
fi
BASE_URL="$CHATBOT_ROOT_URL"

echo "Disabling chatbot..."
curl -s -X POST "$BASE_URL/chat/demo-disable" \
  -H "Content-Type: application/json" | jq .
