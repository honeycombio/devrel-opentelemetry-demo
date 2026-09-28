#!/bin/bash
# Generate the demo CA and the TLS certificate that sso-mocks serves for the
# mocked third-party hosts (identity provider + Globex's status endpoint).
#
# Outputs (committed):
#   src/sso-mocks/certs/ca.pem, server.pem, server-key.pem
#   skaffold-config/charts/otel-services/files/sso-mocks-ca.pem   (trusted by the auth container)
#
# The CA key is thrown away; rerun this script to rotate everything.
# Usage: scripts/generate-sso-mock-certs.sh

set -euo pipefail
cd "$(dirname "$0")/.."

HOSTS=(sso.keystone-id.example sso-status.globex.example)
OUT=src/sso-mocks/certs
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$OUT"

openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -keyout "$WORK/ca-key.pem" -out "$OUT/ca.pem" \
  -subj "/CN=Astronomy Shop demo partner CA" 2>/dev/null

SAN=$(printf 'DNS:%s,' "${HOSTS[@]}"); SAN=${SAN%,}
openssl req -newkey rsa:2048 -nodes \
  -keyout "$OUT/server-key.pem" -out "$WORK/server.csr" \
  -subj "/CN=${HOSTS[0]}" 2>/dev/null
printf 'subjectAltName=%s\nextendedKeyUsage=serverAuth\n' "$SAN" > "$WORK/ext.cnf"
openssl x509 -req -in "$WORK/server.csr" -CA "$OUT/ca.pem" -CAkey "$WORK/ca-key.pem" \
  -CAcreateserial -days 3650 -extfile "$WORK/ext.cnf" -out "$OUT/server.pem" 2>/dev/null

mkdir -p skaffold-config/charts/otel-services/files
cp "$OUT/ca.pem" skaffold-config/charts/otel-services/files/sso-mocks-ca.pem
echo "wrote $OUT and the chart's sso-mocks-ca.pem for: ${HOSTS[*]}"
