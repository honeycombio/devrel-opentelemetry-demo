#!/usr/bin/env bash
# Posts an environment-wide Honeycomb marker for a production deploy.
# Requires HONEYCOMB_MARKERS_API_KEY in the environment (a key with markers permission).
set -euo pipefail

if [ -z "${HONEYCOMB_MARKERS_API_KEY:-}" ]; then
  echo "HONEYCOMB_MARKERS_API_KEY is not set" >&2
  exit 1
fi

VERSION="${1:?usage: create-deploy-marker.sh <version> <run-url>}"
RUN_URL="${2:?usage: create-deploy-marker.sh <version> <run-url>}"

PAYLOAD=$(jq -n \
  --arg message "Deployed $VERSION to devrel-demo" \
  --arg url "$RUN_URL" \
  '{message: $message, type: "deploy", url: $url}')

curl -sS --fail-with-body -X POST "https://api.honeycomb.io/1/markers/__all__" \
  -H "X-Honeycomb-Team: $HONEYCOMB_MARKERS_API_KEY" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD"
