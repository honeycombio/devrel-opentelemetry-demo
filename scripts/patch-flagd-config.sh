#!/bin/sh

set -e

NAMESPACE="${1:-$USER-local}"

# Usage: patch_flag <flag_key> <flag_config_json>
patch_flag() {
  local FLAG_KEY="$1"
  local FLAG_CONFIG="$2"

  echo "Setting flag '$FLAG_KEY' in namespace '$NAMESPACE'..."

  CURRENT_JSON=$(kubectl get configmap flagd-config -n "$NAMESPACE" -o jsonpath='{.data.demo\.flagd\.json}')
  UPDATED_JSON=$(echo "$CURRENT_JSON" | jq --arg key "$FLAG_KEY" --argjson config "$FLAG_CONFIG" '.flags[$key] = $config')

  kubectl get configmap flagd-config -n "$NAMESPACE" -o json |
    jq --arg json "$UPDATED_JSON" '.data["demo.flagd.json"] = $json' |
    kubectl apply --server-side --force-conflicts --field-manager='helm' -f -

  echo "Flag '$FLAG_KEY' set."
}

patch_flag "cartservice.add-db-call" '{
  "description": "Add a DB call to the cart service",
  "state": "ENABLED",
  "variants": { "on": true, "off": false },
  "defaultVariant": "off"
}'

patch_flag "chatbot.enabled" '{
  "description": "Enable chatbot LLM integration",
  "state": "ENABLED",
  "variants": { "on": true, "off": false },
  "defaultVariant": "off"
}'


patch_flag "llm.performEvals" '{
  "description": "Enable LLM evaluation scoring (bias, hallucination, relevance) on chatbot responses",
  "state": "ENABLED",
  "variants": { "on": true, "off": false },
  "defaultVariant": "off"
}'

echo "Restarting flagd to pick up new config..."
kubectl rollout restart deployment flagd -n "$NAMESPACE"
kubectl rollout status deployment flagd -n "$NAMESPACE" --timeout=60s

echo "Done."
