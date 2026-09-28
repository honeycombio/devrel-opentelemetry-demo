#!/usr/bin/env bash
# Skaffold deploy "after" hook: posts the Honeycomb deploy marker as soon as
# helm finishes (wait: true, so pods are ready) — rather than after
# `skaffold run --port-forward` exits, which is whenever you hit Ctrl+C.
# ./run exports DEPLOY_MARKER_MESSAGE. Best-effort: never fails the deploy, and
# the curl has a timeout so a stalled API cannot hold up port-forwarding.

if [ -z "${DEPLOY_MARKER_MESSAGE:-}" ]; then
  echo "DEPLOY_MARKER_MESSAGE not set (not launched via ./run?); skipping Honeycomb deploy marker" >&2
  exit 0
fi

"$(dirname "$0")/create-local-deploy-marker.sh" "$DEPLOY_MARKER_MESSAGE" \
  || echo "Warning: failed to post Honeycomb deploy marker" >&2
exit 0
