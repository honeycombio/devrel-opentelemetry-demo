#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   upload_frontend_sourcemaps.sh s3://bucket/prefix
#
# Env overrides:
#   NAMESPACE          - k8s namespace (default: default)
#   FRONTEND_LABEL     - pod label selector (default: app=frontend)
#   FRONTEND_CONTAINER - container name (default: frontend)
#   NODE_BIN_PATH      - node path in container
#                        (default: /nodejs/bin/node)

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 s3://bucket/prefix" >&2
  exit 1
fi

S3_DEST="$1"

if [[ "${S3_DEST}" != s3://* ]]; then
  echo "ERROR: S3 destination must be s3://bucket/prefix" >&2
  exit 1
fi

command -v kubectl >/dev/null 2>&1 || {
  echo "ERROR: kubectl not found in PATH" >&2
  exit 1
}

command -v aws >/dev/null 2>&1 || {
  echo "ERROR: aws CLI not found in PATH" >&2
  exit 1
}

NAMESPACE="${NAMESPACE:-default}"
FRONTEND_LABEL="${FRONTEND_LABEL:-app=frontend}"
FRONTEND_CONTAINER="${FRONTEND_CONTAINER:-frontend}"
NODE_BIN_PATH="${NODE_BIN_PATH:-/nodejs/bin/node}"

echo "Namespace:          ${NAMESPACE}"
echo "Frontend label:     ${FRONTEND_LABEL}"
echo "Frontend container: ${FRONTEND_CONTAINER}"
echo "Node binary path:   ${NODE_BIN_PATH}"
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
  echo "ERROR: No pod found for label '${FRONTEND_LABEL}' " \
       "in namespace '${NAMESPACE}'" >&2
  exit 1
fi

echo "Using pod: ${POD_NAME}"
echo

echo "Checking node binary in container..."
if ! kubectl exec -n "${NAMESPACE}" \
        -c "${FRONTEND_CONTAINER}" \
        "${POD_NAME}" -- \
        "${NODE_BIN_PATH}" -v; then
  echo "ERROR: '${NODE_BIN_PATH}' not runnable in container." >&2
  echo "Run this manually to debug:" >&2
  echo "  kubectl exec -n ${NAMESPACE} ${POD_NAME} -- " \
       "${NODE_BIN_PATH} -v" >&2
  exit 1
fi
echo

WORK_DIR="$(mktemp -d)"
LOCAL_STATIC_DIR="${WORK_DIR}/static"

cleanup() {
  rm -rf "${WORK_DIR}" || true
}
trap cleanup EXIT

mkdir -p "${LOCAL_STATIC_DIR}"

echo "Listing files under /app/.next/static..."
FILE_LIST="$(
  kubectl exec -n "${NAMESPACE}" \
    -c "${FRONTEND_CONTAINER}" \
    "${POD_NAME}" -- \
    "${NODE_BIN_PATH}" -e '
      const fs = require("fs");
      const path = require("path");
      const root = "/app/.next/static";
      if (!fs.existsSync(root)) {
        console.error("ERROR: " + root + " does not exist");
        process.exit(1);
      }
      function walk(dir) {
        for (const ent of fs.readdirSync(
          dir, { withFileTypes: true })) {
          const full = path.join(dir, ent.name);
          if (ent.isDirectory()) walk(full);
          else {
            const rel = full.slice(root.length + 1);
            console.log(rel);
          }
        }
      }
      walk(root);
    '
)"

echo "---- file listing from container ----"
echo "${FILE_LIST}"
echo "-------------------------------------"
echo

if echo "${FILE_LIST}" | grep -q "^ERROR:"; then
  echo "Container reported an error:" >&2
  echo "${FILE_LIST}" >&2
  exit 1
fi

if [ -z "${FILE_LIST}" ]; then
  echo "ERROR: No files found under /app/.next/static" >&2
  exit 1
fi

echo "Copying files locally (no tar, using node fs.readFileSync)..."
COUNT=0
while IFS= read -r rel; do
  [ -z "${rel}" ] && continue
  src_path="/app/.next/static/${rel}"
  dst_path="${LOCAL_STATIC_DIR}/${rel}"
  dst_dir="$(dirname "${dst_path}")"
  mkdir -p "${dst_dir}"

  echo "  -> ${rel}"
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

if [ "${COUNT}" -eq 0 ]; then
  echo "ERROR: Did not copy any files locally" >&2
  exit 1
fi

echo
echo "Copied ${COUNT} files locally."
echo "Syncing to S3: ${S3_DEST}"
aws s3 sync "${LOCAL_STATIC_DIR}" "${S3_DEST}"

echo "Done."
echo "Uploaded sourcemaps from /app/.next/static in pod:"
echo "  ${NAMESPACE}/${POD_NAME}"
echo "to:"
echo "  ${S3_DEST}"