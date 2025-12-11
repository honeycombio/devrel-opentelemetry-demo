#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   upload_chunks_only.sh s3://bucket/root/.next/static/chunks
#
# Env variables:
#   NAMESPACE
#   FRONTEND_LABEL
#   FRONTEND_CONTAINER
#   NODE_BIN_PATH (default: /nodejs/bin/node)

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 s3://bucket/root/.next/static/chunks" >&2
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

CHUNKS_ROOT="/app/.next/static/chunks"

echo "Namespace:          ${NAMESPACE}"
echo "Frontend label:     ${FRONTEND_LABEL}"
echo "Frontend container: ${FRONTEND_CONTAINER}"
echo "Node binary path:   ${NODE_BIN_PATH}"
echo "Chunks root:        ${CHUNKS_ROOT}"
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
LOCAL_CHUNKS_DIR="${WORK_DIR}/chunks"

cleanup() {
  rm -rf "${WORK_DIR}" || true
}
trap cleanup EXIT

mkdir -p "${LOCAL_CHUNKS_DIR}"

echo "Listing files under ${CHUNKS_ROOT}..."
FILE_LIST="$(
  kubectl exec -n "${NAMESPACE}" \
    -c "${FRONTEND_CONTAINER}" \
    "${POD_NAME}" -- \
    "${NODE_BIN_PATH}" -e "
      const fs = require('fs');
      const path = require('path');
      const root = '${CHUNKS_ROOT}';

      if (!fs.existsSync(root)) {
        console.error('ERROR: ' + root + ' does not exist.');
        process.exit(1);
      }

      function walk(dir) {
        for (const ent of fs.readdirSync(dir, {withFileTypes: true})) {
          const full = path.join(dir, ent.name);
          if (ent.isDirectory()) walk(full);
          else {
            const rel = full.slice(root.length + 1);
            console.log(rel);
          }
        }
      }

      walk(root);
    "
)"

echo "--- Discovered chunk files ---"
echo "${FILE_LIST}"
echo "------------------------------"
echo

if echo "${FILE_LIST}" | grep -q "^ERROR:"; then
  echo "${FILE_LIST}" >&2
  exit 1
fi

if [ -z "${FILE_LIST}" ]; then
  echo "ERROR: No chunk files found." >&2
  exit 1
fi

echo "Copying chunk files..."
COUNT=0

while IFS= read -r rel; do
  [ -z "${rel}" ] && continue

  src_path="${CHUNKS_ROOT}/${rel}"
  dst_path="${LOCAL_CHUNKS_DIR}/${rel}"
  dst_dir="$(dirname "${dst_path}")"
  mkdir -p "${dst_dir}"

  echo "   -> ${rel}"

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
    ' "${src_path}" > "${dst_path}"

  COUNT=$((COUNT + 1))
done <<< "${FILE_LIST}"

echo
echo "Copied ${COUNT} chunk files."
echo "Syncing to S3 → ${S3_DEST}"
aws s3 sync "${LOCAL_CHUNKS_DIR}" "${S3_DEST}"

echo
echo "Done. Uploaded:"
echo "   /app/.next/static/chunks/**/*"
echo "to S3 prefix:"
echo "   ${S3_DEST}"