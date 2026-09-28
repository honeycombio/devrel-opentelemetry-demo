#!/bin/bash
#
# local-honeycomb-destination
# Print the Honeycomb team + environment that a local `./run` deploy sends to.
#
# Resolves the ingest key the same way ./run does: source .skaffold.env, then
# HONEYCOMB_INGEST_KEY, falling back to HONEYCOMB_API_KEY. So a key exported in
# your shell (not in .skaffold.env) counts, same as it does for ./run.
#

set -e

cd "$(git rev-parse --show-toplevel)"

if [[ -f .skaffold.env ]]; then
    set -a
    eval "$(cat '.skaffold.env')"
    set +a
fi

INGEST_KEY="${HONEYCOMB_INGEST_KEY:-$HONEYCOMB_API_KEY}"

if [ -z "$INGEST_KEY" ]; then
  echo "No Honeycomb key: set HONEYCOMB_API_KEY (or HONEYCOMB_INGEST_KEY) in .skaffold.env or your shell" >&2
  exit 1
fi

curl -s https://api.honeycomb.io/1/auth -H "X-Honeycomb-Team: $INGEST_KEY" \
  | jq '{team: .team.slug, environment: .environment.slug}'
