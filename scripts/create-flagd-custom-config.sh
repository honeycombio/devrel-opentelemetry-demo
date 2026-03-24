#!/bin/bash
# Creates the flagd-custom-config ConfigMap in the target namespace from src/flagd/demo.flagd.json.
# This ConfigMap must exist before the otel-demo Helm release deploys flagd,
# because flagd mounts it as a second --uri source alongside the chart's built-in flags.
# Idempotent: safe to run on every deploy.

set -e

NAMESPACE="${1:-$USER-local}"

echo "Creating flagd-custom-config in namespace $NAMESPACE..."

kubectl create configmap flagd-custom-config \
  --from-file=demo.flagd.json=src/flagd/demo.flagd.json \
  --namespace "$NAMESPACE" \
  --dry-run=client -o yaml | kubectl apply -f -

echo "flagd-custom-config ready."
