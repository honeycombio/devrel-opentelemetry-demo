#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   upload_flat_recursive.sh s3://bucket/prefix
#
# Optional env:
#   NAMESPACE (default: default)
#   FRONTEND_LABEL (default: app=frontend)
#   FRONTEND_CONTAINER (default: frontend)
#   NODE_BIN_PATH (default: /nodejs/bin/node)
#   SRC_ROOT (default: /app/.next/static/chunks)

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 s3://bucket/prefix" >&2
  exit 1
fi

S3_DEST="$1"
if [[ "${S3_DEST}" != s3://* ]]; then
  echo "ERROR: S3 destination must begin with s3://..." >&2
  exit 1
fi

command -v kubectl >/dev/null 2>&1 || {
  echo "ERROR: kubectl not available" >&2
  exit 1
}

command -v aws >/dev/null 2>&1 || {
  echo "ERROR: aws CLI not available" >&2
  exit 1
}

NAMESPACE="${NAMESPACE:-default}"
FRONTEND_LABEL="${FRONTEND_LABEL:-app=frontend}"
FRONTEND_CONTAINER="${FRONTEND_CONTAINER:-frontend}"
NODE_BIN_PATH="${NODE_BIN_PATH:-/nodejs/bin/node}"
SRC_ROOT="${SRC_ROOT:-/app/.next/static/chunks}"

echo "Namespace:          ${NAMESPACE}"
echo "Frontend label:     ${FRONTEND_LABEL}"
echo "Frontend container: ${FRONTEND_CONTAINER}"
echo "Node binary path:   ${NODE_BIN_PATH}"
echo "Source root:        ${SRC_ROOT}"
echo "S3 destination:     ${S3_DEST}"
echo

echo "Finding frontend pod..."
POD_NAME="$(
  kubectl get pods \
    -n "${NAMESPACE}" \
    -l "${FRONTEND_LABEL}" \
    -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true
)"

if [ -z "${POD_NAME}" ]; then
  echo "ERROR: No pod found" >&2
  exit 1
fi

echo "Using pod: ${POD_NAME}"
echo

echo "Checking node binary..."
if ! kubectl exec -n "${NAMESPACE}" \
    -c "${FRONTEND_CONTAINER}" \
    "${POD_NAME}" -- \
    "${NODE_BIN_PATH}" -v >/dev/null 2>&1; then
  echo "ERROR: Cannot run ${NODE_BIN_PATH}" >&2
  exit 1
fi

WORK_DIR="$(mktemp -d)"
LOCAL_DIR="${WORK_DIR}/flat"

cleanup() {
  rm -rf "${WORK_DIR}" || true
}
trap cleanup EXIT

mkdir -p "${LOCAL_DIR}"

echo "Recursively listing files under ${SRC_ROOT}..."
FILE_LIST="$(
  kubectl exec -n "${NAMESPACE}" \
    -c "${FRONTEND_CONTAINER}" \
    "${POD_NAME}" -- \
    "${NODE_BIN_PATH}" -e "
      const fs = require('fs');
      const path = require('path');
      const root = '${SRC_ROOT}';

      if (!fs.existsSync(root)) {
        console.error('ERROR: ' + root + ' does not exist.');
        process.exit(1);
      }

      function walk(dir) {
        for (const ent of fs.readdirSync(dir, {withFileTypes: true})) {
          const full = path.join(dir, ent.name);
          if (ent.isDirectory()) walk(full);
          else console.log(full);
        }
      }

      walk(root);
    "
)"

if echo "${FILE_LIST}" | grep -q "^ERROR:"; then
  echo "${FILE_LIST}" >&2
  exit 1
fi

if [ -z "${FILE_LIST}" ]; then
  echo "ERROR: No files found under ${SRC_ROOT}." >&2
  exit 1
fi

echo
echo "Copying files (flattening to S3 root)..."
COUNT=0
declare -A SEEN_BASENAME=()

while IFS= read -r full; do
  [ -z "${full}" ] && continue

  base_name="$(basename "${full}")"
  dst_path="${LOCAL_DIR}/${base_name}"

  # Recommended safety: fail on collisions (same basename from different dirs)
  if [[ -n "${SEEN_BASENAME[${base_name}]:-}" ]]; then
    echo "ERROR: Basename collision for '${base_name}'" >&2
    echo "  First:  ${SEEN_BASENAME[${base_name}]}" >&2
    echo "  Second: ${full}" >&2
    exit 1
  fi
  SEEN_BASENAME["${base_name}"]="${full}"

  echo "   -> ${full}  =>  ${base_name}"

  kubectl exec -n "${NAMESPACE}" \
    -c "${FRONTEND_CONTAINER}" \
    "${POD_NAME}" -- \
    "${NODE_BIN_PATH}" -e '
      const fs = require("fs");
      const p = process.argv[1];
      try {
        const buf = fs.readFileSync(p);
        process.stdout.write(buf);
      } catch (err) {
        console.error("ERROR reading " + p + ": " + err.message);
        process.exit(1);
      }
    ' "${full}" > "${dst_path}"

  COUNT=$((COUNT + 1))
done <<< "${FILE_LIST}"

echo
echo "Copied ${COUNT} files."
echo "Syncing to S3 → ${S3_DEST}"
aws s3 sync "${LOCAL_DIR}" "${S3_DEST}"

echo
echo "Done. Uploaded ALL files under:"
echo "   ${SRC_ROOT}/**/*"
echo "Flattened into S3 prefix root:"
echo "   ${S3_DEST}"
