#!/usr/bin/env bash
# Copyright The OpenTelemetry Authors
# SPDX-License-Identifier: Apache-2.0
#
# Validate telemetry-schema/ the same way CI does (.github/workflows/checks.yml
# -> weaver-check). Requires Docker.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCHEMA_DIR="${REPO_ROOT}/telemetry-schema"
WEAVER_IMAGE="otel/weaver:v0.22.1"

echo "Checking ${SCHEMA_DIR} with ${WEAVER_IMAGE}"

exec docker run --rm \
  --mount "type=bind,src=${SCHEMA_DIR},dst=/home/weaver/source,readonly" \
  "${WEAVER_IMAGE}" \
  registry check -r source
