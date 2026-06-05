#!/bin/bash
# Query the email addresses that have placed orders in the production deployment.
#
# Orders flow Kafka("orders") -> accounting service -> Postgres table
# accounting."order" (column "email"). This script reads that table directly
# from the postgresql pod in the production namespace.
#
# Usage:
#   AWS_PROFILE=really-devrel-sandbox ./scripts/query-production-order-emails.sh
#
# Env overrides:
#   CONTEXT    kubectl context     (default: devrel-demo-aws)
#   NAMESPACE  k8s namespace        (default: devrel-demo  <- the shared "production" deploy)
#   PGUSER     postgres superuser   (default: root)
#   PGPASS     postgres password    (default: otel)
#   PGDB       database name        (default: otel)

set -euo pipefail

CONTEXT="${CONTEXT:-devrel-demo-aws}"
NAMESPACE="${NAMESPACE:-devrel-demo}"
PGUSER="${PGUSER:-root}"
PGPASS="${PGPASS:-otel}"
PGDB="${PGDB:-otel}"

if [[ -z "${AWS_PROFILE:-}" ]]; then
  echo "Defaulting AWS_PROFILE=really-devrel-sandbox (prod cluster account)" >&2
  export AWS_PROFILE=really-devrel-sandbox
fi

# Pod name has a generated suffix, so resolve it by deployment label.
POD="$(kubectl --context "$CONTEXT" -n "$NAMESPACE" \
  get pods -l app.kubernetes.io/name=postgresql -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)"
if [[ -z "$POD" ]]; then
  # Fall back to a name match if the label differs.
  POD="$(kubectl --context "$CONTEXT" -n "$NAMESPACE" \
    get pods -o name | grep -m1 postgres | sed 's#pod/##')"
fi
if [[ -z "$POD" ]]; then
  echo "Could not find a postgres pod in $CONTEXT/$NAMESPACE" >&2
  exit 1
fi

SQL='SELECT
        COUNT(*)                              AS total_orders,
        COUNT(email)                          AS orders_with_email,
        COUNT(*) - COUNT(email)               AS orders_without_email,
        COUNT(DISTINCT email)                 AS distinct_emails
      FROM accounting."order";

      SELECT email, COUNT(*) AS orders
        FROM accounting."order"
       WHERE email IS NOT NULL
       GROUP BY email
       ORDER BY orders DESC, email;'

kubectl --context "$CONTEXT" -n "$NAMESPACE" exec "$POD" -- \
  env PGPASSWORD="$PGPASS" psql -U "$PGUSER" -d "$PGDB" -P pager=off -c "$SQL"
