#!/usr/bin/env bash
# Turn OFF the cartservice.add-db-call feature flag.
# Patches the full ConfigMap first (to ensure all flags exist), then sets the flag to 0%.
#
# Usage: ./scripts/flag-dbcall-off.sh [namespace]

set -euo pipefail

NAMESPACE="${1:-$USER-local}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Ensure the ConfigMap has all flags from source
"$SCRIPT_DIR/patch-flagd-configmap.sh" "$NAMESPACE"

# Set the db-call flag to 0%, then restart flagd so it picks up the change
# immediately (otherwise kubelet ConfigMap propagation can take 60-90s).
"$SCRIPT_DIR/set-flag-percentage.sh" 0 "$NAMESPACE"

echo "Restarting flagd to pick up the 0% setting..."
kubectl rollout restart deployment/flagd -n "$NAMESPACE"
kubectl rollout status deployment/flagd -n "$NAMESPACE" --timeout=60s
echo "Flag is OFF."
