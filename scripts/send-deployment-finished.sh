#!/usr/bin/env bash
# Copyright The OpenTelemetry Authors
# SPDX-License-Identifier: Apache-2.0
# Tells Honeycomb that a production deploy has finished, using a deployment.finished goal event.
# Requires HONEYCOMB_GOAL_WEBHOOK in the environment.
# The release digest lists the commits between the previous release tag and <version>. It is empty
# when <version> is not a release tag (for example "latest") or the tags are not fetched.
set -euo pipefail

if [ -z "${HONEYCOMB_GOAL_WEBHOOK:-}" ]; then
  echo "HONEYCOMB_GOAL_WEBHOOK is not set" >&2
  exit 1
fi

VERSION="${1:?usage: send-deployment-finished.sh <version> <collector-version> <run-url>}"
COLLECTOR_VERSION="${2:?usage: send-deployment-finished.sh <version> <collector-version> <run-url>}"
RUN_URL="${3:?usage: send-deployment-finished.sh <version> <collector-version> <run-url>}"

MAX_DIGEST_ENTRIES=100

PREVIOUS_VERSION=""
DIGEST_RANGE=""
if git rev-parse --verify --quiet "refs/tags/$VERSION" >/dev/null; then
  PREVIOUS_VERSION=$(git tag --list '*.*.*-release' --sort=v:refname | grep -x -B1 -F "$VERSION" | grep -vx -F "$VERSION" || true)
  if [ -n "$PREVIOUS_VERSION" ]; then
    DIGEST_RANGE="refs/tags/$PREVIOUS_VERSION..refs/tags/$VERSION"
  fi
fi

RELEASE_DIGEST=$(
  if [ -n "$DIGEST_RANGE" ]; then
    git log --max-count="$MAX_DIGEST_ENTRIES" --format='%h%x09%s' "$DIGEST_RANGE"
  fi | jq -R -s '
    split("\n") | map(select(length > 0) | split("\t") | {sha: .[0], title: .[1]})'
)

PAYLOAD=$(jq -n \
  --arg id "devrel-${GITHUB_RUN_ID:-$(date +%s)}-${GITHUB_RUN_ATTEMPT:-1}" \
  --arg version "$VERSION" \
  --arg previous_version "$PREVIOUS_VERSION" \
  --arg collector_version "$COLLECTOR_VERSION" \
  --arg commit "${GITHUB_SHA:-$(git rev-parse HEAD)}" \
  --arg deployed_by "${GITHUB_ACTOR:-unknown}" \
  --arg repository "${GITHUB_REPOSITORY:-honeycombio/devrel-opentelemetry-demo}" \
  --arg run_url "$RUN_URL" \
  --arg deployed_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --argjson release_digest "$RELEASE_DIGEST" \
  '{
    type: "deployment.finished",
    version: 1,
    id: $id,
    data: {
      service: "devrel-opentelemetry-demo",
      service_version: $version,
      environment: "devrel-demo",
      previous_version: $previous_version,
      collector_version: $collector_version,
      cloud_provider: "aws",
      commit: $commit,
      deployed_by: $deployed_by,
      deployed_at: $deployed_at,
      repository: $repository,
      run_url: $run_url,
      release_digest_count: ($release_digest | length),
      release_digest: $release_digest
    }
  }')

if [ "${DRY_RUN:-}" = "1" ]; then
  echo "$PAYLOAD"
  exit 0
fi

curl -sS --fail-with-body -X POST "https://api.honeycomb.io/1/goals/events" \
  -H "Authorization: Bearer $HONEYCOMB_GOAL_WEBHOOK" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD"
