#!/usr/bin/env bash
# Posts an environment-wide Honeycomb marker for a local (./run) deploy.
# Requires HONEYCOMB_MARKERS_KEY in the environment (a key with markers permission) —
# ./run already exports this before calling here.
set -euo pipefail

if [ -z "${HONEYCOMB_MARKERS_KEY:-}" ]; then
  echo "HONEYCOMB_MARKERS_KEY is not set" >&2
  exit 1
fi

MESSAGE="${1:?usage: create-local-deploy-marker.sh <message>}"

PAYLOAD=$(jq -n --arg message "$MESSAGE" '{message: $message, type: "deploy"}')

curl -sS --fail-with-body -X POST "https://api.honeycomb.io/1/markers/__all__" \
  -H "X-Honeycomb-Team: $HONEYCOMB_MARKERS_KEY" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD"
