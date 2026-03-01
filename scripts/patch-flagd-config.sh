#!/bin/sh

set -e

NAMESPACE="${1:-$USER-local}"
FLAG_KEY="cartservice.add-db-call"

echo "Checking flagd-config in namespace '$NAMESPACE' for flag '$FLAG_KEY'..."

CURRENT_JSON=$(kubectl get configmap flagd-config -n "$NAMESPACE" -o jsonpath='{.data.demo\.flagd\.json}')

if echo "$CURRENT_JSON" | jq -e ".flags[\"$FLAG_KEY\"]" > /dev/null 2>&1; then
  echo "Flag '$FLAG_KEY' already exists. Skipping."
  exit 0
fi

echo "Adding flag '$FLAG_KEY'..."
UPDATED_JSON=$(echo "$CURRENT_JSON" | jq --arg key "$FLAG_KEY" '.flags[$key] = {
  "description": "Add a DB call to the cart service",
  "state": "ENABLED",
  "variants": { "on": true, "off": false },
  "defaultVariant": "off"
}')

kubectl get configmap flagd-config -n "$NAMESPACE" -o json \
  | jq --arg json "$UPDATED_JSON" '.data["demo.flagd.json"] = $json' \
  | kubectl apply --server-side --force-conflicts --field-manager='helm' -f -

echo "Restarting flagd to pick up new config..."
kubectl rollout restart deployment flagd -n "$NAMESPACE"
kubectl rollout status deployment flagd -n "$NAMESPACE" --timeout=60s

echo "Done. Flag '$FLAG_KEY' added to flagd-config."
