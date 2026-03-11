#!/usr/bin/env bash
# Send a marker to Honeycomb.
# Requires HONEYCOMB_MARKER_API_KEY environment variable.
#
# Usage: scripts/send-marker.sh --type <type> --message <message> [--dataset <dataset>]
#
# Examples:
#   scripts/send-marker.sh --type deploy --message "deploy cart abc1234"
#   scripts/send-marker.sh --type feature-flag --message "flag → 50%" --dataset cart

set -euo pipefail

if [ -z "${HONEYCOMB_MARKER_API_KEY:-}" ]; then
  echo "⚠️  HONEYCOMB_MARKER_API_KEY not set — skipping marker" >&2
  exit 0
fi

TYPE=""
MESSAGE=""
DATASET="__all__"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --type) TYPE="$2"; shift 2 ;;
    --message) MESSAGE="$2"; shift 2 ;;
    --dataset) DATASET="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [ -z "$TYPE" ] || [ -z "$MESSAGE" ]; then
  echo "Usage: $0 --type <type> --message <message> [--dataset <dataset>]" >&2
  exit 1
fi

# Build JSON payload
PAYLOAD=$(cat <<EOF
{
  "message": "$MESSAGE",
  "type": "$TYPE"
}
EOF
)

RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "https://api.honeycomb.io/1/markers/$DATASET" \
  -H "X-Honeycomb-Team: $HONEYCOMB_MARKER_API_KEY" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD")

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | head -n -1)

if [[ "$HTTP_CODE" -ge 200 && "$HTTP_CODE" -lt 300 ]]; then
  echo "📍 Marker sent: [$TYPE] $MESSAGE"
else
  echo "⚠️  Marker failed (HTTP $HTTP_CODE): $BODY" >&2
fi
