#!/bin/bash
# Call the auth service's Login RPC from a throwaway grpcurl pod in the cluster.
#
# Usage:
#   scripts/auth-login.sh <email> [password]     # password login
#   scripts/auth-login.sh <email> --sso          # SSO login
#
# Password tenants all use the demo password from scripts/generate-auth-tenants.py.
# Pick users from src/load-generator/corporate_users.json.
#
# Env overrides:
#   NAMESPACE  k8s namespace   (default: $USER-local)
#   CONTEXT    kubectl context (default: current context)

set -euo pipefail

EMAIL="${1:?usage: $0 <email> [password|--sso]}"
SECOND="${2:-stargazer-2026}"
NAMESPACE="${NAMESPACE:-${USER}-local}"
KUBECTL=(kubectl -n "$NAMESPACE")
if [[ -n "${CONTEXT:-}" ]]; then
  KUBECTL+=(--context "$CONTEXT")
fi

if [[ "$SECOND" == "--sso" ]]; then
  BODY="{\"email\":\"$EMAIL\",\"method\":\"sso\"}"
else
  BODY="{\"email\":\"$EMAIL\",\"password\":\"$SECOND\",\"method\":\"password\"}"
fi

"${KUBECTL[@]}" run "grpcurl-$RANDOM" --rm -i --restart=Never --quiet \
  --image=fullstorydev/grpcurl:v1.9.3 -- \
  -plaintext -d "$BODY" auth:8080 oteldemo.AuthService/Login
