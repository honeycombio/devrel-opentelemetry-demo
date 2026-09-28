#!/bin/bash
# Summarize the corporate-login tenants in the auth schema (companies, users,
# login methods, status-check config, recent login events).
#
# Usage:
#   scripts/query-auth-tenants.sh                 # your local namespace ($USER-local)
#   NAMESPACE=devrel-demo CONTEXT=devrel-demo-aws AWS_PROFILE=really-devrel-sandbox \
#     scripts/query-auth-tenants.sh               # production
#
# Env overrides:
#   CONTEXT    kubectl context   (default: current context)
#   NAMESPACE  k8s namespace     (default: $USER-local)

set -euo pipefail

NAMESPACE="${NAMESPACE:-${USER}-local}"
KUBECTL=(kubectl -n "$NAMESPACE")
if [[ -n "${CONTEXT:-}" ]]; then
  KUBECTL+=(--context "$CONTEXT")
fi

POD="$("${KUBECTL[@]}" get pods -l app.kubernetes.io/name=postgresql -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
if [[ -z "$POD" ]]; then
  echo "Could not find a postgres pod in namespace $NAMESPACE" >&2
  exit 1
fi

SQL='SELECT login_method, COUNT(*) AS companies FROM auth.company GROUP BY 1 ORDER BY 1;

     SELECT c.company_id, c.login_method, COUNT(u.*) AS users
       FROM auth.company c LEFT JOIN auth.corporate_user u USING (company_id)
      GROUP BY 1, 2 ORDER BY users DESC LIMIT 10;

     SELECT COUNT(*) AS total_users FROM auth.corporate_user;'

# sso_status_check only exists once the status-check schema is present.
SQL_STATUS="SELECT * FROM auth.sso_status_check;"
SQL_EVENTS="SELECT company_id, method, result, COUNT(*) FROM auth.login_event
             WHERE created_at > now() - interval '1 hour' GROUP BY 1, 2, 3 ORDER BY 4 DESC LIMIT 15;"

psql() {
  "${KUBECTL[@]}" exec "$POD" -- env PGPASSWORD=otel psql -U root -d otel -P pager=off "$@"
}

psql -c "$SQL"
psql -c "$SQL_STATUS" 2>/dev/null || echo "(no auth.sso_status_check table)"
psql -c "$SQL_EVENTS"
