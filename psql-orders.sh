#!/usr/bin/env bash
# Drops you into a psql prompt against the in-cluster postgres,
# pre-pointed at the `accounting` schema (orders, orderitem, shipping).
#
# Usage:
#   ./psql-orders.sh                  # interactive psql
#   ./psql-orders.sh -c 'SELECT ...'  # one-shot query
#
# Reminder: the orders table is `"order"` (reserved word — keep the quotes):
#   SELECT order_id, email, order_status, created_at
#   FROM "order"
#   ORDER BY created_at DESC
#   LIMIT 20;

set -euo pipefail

NAMESPACE="${NAMESPACE:-kenrimple-local}"
DEPLOY="${DEPLOY:-deployment/postgresql}"
DB="${DB:-otel}"
USER="${PGUSER:-otelu}"
PASS="${PGPASSWORD:-otelp}"
SCHEMA="${SCHEMA:-accounting}"

cat <<EOF
Connecting to ${DEPLOY} in ns/${NAMESPACE} as ${USER}@${DB}
search_path = ${SCHEMA}, public

Tables in ${SCHEMA}:
  "order"     order_id, email, user_id, transaction_id,
              total_cost_currency_code, total_cost_units, total_cost_nanos,
              order_status, created_at, refunded_at
  orderitem   order_id, product_id, quantity,
              item_cost_currency_code, item_cost_units, item_cost_nanos
  shipping    shipping_tracking_id, order_id,
              shipping_cost_currency_code, shipping_cost_units, shipping_cost_nanos,
              street_address, city, state, country, zip_code

psql tips:  \dt   list tables    \d "order"   describe table    \q   quit

EOF

exec kubectl exec -it -n "${NAMESPACE}" "${DEPLOY}" -- \
  env PGPASSWORD="${PASS}" PGOPTIONS="-c search_path=${SCHEMA},public" \
  psql -U "${USER}" -d "${DB}" -v ON_ERROR_STOP=1 "$@"
