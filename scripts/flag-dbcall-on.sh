#!/usr/bin/env bash
# Turn ON the cartservice.add-db-call feature flag at 50%.
#
# Usage: ./scripts/flag-dbcall-on.sh [namespace]

set -euo pipefail

NAMESPACE="${1:-$USER-local}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

"$SCRIPT_DIR/set-flag-percentage.sh" 50 "$NAMESPACE"
