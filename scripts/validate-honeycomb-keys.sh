#!/bin/bash

#
# validate-honeycomb-keys.sh
# Validates the resolved Honeycomb keys in .skaffold.env have the right
# api_key_access permissions:
#   - the ingest key (HONEYCOMB_INGEST_KEY, falling back to HONEYCOMB_API_KEY)
#     must have `events`
#   - the marker key (HONEYCOMB_MARKERS_KEY, falling back to HONEYCOMB_API_KEY)
#     must have `markers`
# When both resolve to the same key, it's checked once and both perms are
# asserted on a single response.
#
# Usage: validate-honeycomb-keys.sh [-q|--quiet]
#   -q, --quiet   Only output on errors
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git rev-parse --show-toplevel)"
ENV_FILE="${REPO_ROOT}/.skaffold.env"

# Parse arguments
QUIET=false
while [[ $# -gt 0 ]]; do
  case $1 in
    -q|--quiet)
      QUIET=true
      shift
      ;;
    *)
      echo "Unknown option: $1"
      echo "Usage: $0 [-q|--quiet]"
      exit 1
      ;;
  esac
done

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m' # No Color

# Logs go to stderr so callers can capture function stdout (used to pass
# the /1/auth response body back from auth_check).
log() {
  if [ "$QUIET" = false ]; then
    echo -e "$@" >&2
  fi
}

log_error() {
  echo -e "$@" >&2
}

# Load environment variables
if [ ! -f "$ENV_FILE" ]; then
  log_error "${RED}Error: .skaffold.env file not found at ${ENV_FILE}${NC}"
  exit 1
fi

source "$ENV_FILE"

# Check required tools
if ! command -v jq &> /dev/null; then
  log_error "${RED}Error: jq is required but not installed.${NC}"
  exit 1
fi

if ! command -v curl &> /dev/null; then
  log_error "${RED}Error: curl is required but not installed.${NC}"
  exit 1
fi

# Resolve effective keys: explicit override wins, otherwise fall back to
# HONEYCOMB_API_KEY. Mirror the same defaulting that ./run does so the
# validation matches what the collector will actually see.
INGEST_KEY="${HONEYCOMB_INGEST_KEY:-$HONEYCOMB_API_KEY}"
MARKER_KEY="${HONEYCOMB_MARKERS_KEY:-$HONEYCOMB_API_KEY}"

errors=0

log "=============================================="
log "Validating Honeycomb API Keys"
log "=============================================="
log ""

# auth_check <key> <required_perms_csv> <label>
# Hits /1/auth once, asserts every comma-separated perm in api_key_access is
# true. Logs to stderr; on success, echoes the response body to stdout so the
# caller can extract team/env identifiers for cross-key comparison.
# Returns 0 on success, 1 on any failure.
auth_check() {
  local key="$1"
  local perms_csv="$2"
  local label="$3"

  if [ -z "$key" ]; then
    log_error "   ${RED}✗ ${label} key is not set (set HONEYCOMB_API_KEY or the key-specific override)${NC}"
    return 1
  fi

  local response http_code body
  response=$(curl -s -w "\n%{http_code}" -H "X-Honeycomb-Team: $key" \
                  "https://api.honeycomb.io/1/auth")
  http_code=$(echo "$response" | tail -n1)
  body=$(echo "$response" | sed '$d')

  if [ "$http_code" != "200" ]; then
    log_error "   ${RED}✗ ${label} key failed to authenticate (HTTP $http_code)${NC}"
    log_error "   ${RED}  Response: $body${NC}"
    return 1
  fi

  local env_name team_name
  env_name=$(echo "$body" | jq -r '.environment.name // "classic"')
  team_name=$(echo "$body" | jq -r '.team.name // empty')

  local missing=""
  local perm
  IFS=',' read -ra perm_list <<< "$perms_csv"
  for perm in "${perm_list[@]}"; do
    local has_perm
    has_perm=$(echo "$body" | jq -r ".api_key_access.${perm} // false")
    if [ "$has_perm" != "true" ]; then
      missing="${missing}${missing:+, }${perm}"
    fi
  done

  if [ -n "$missing" ]; then
    log_error "   ${RED}✗ ${label} key (Team: $team_name, Environment: $env_name) is missing permission(s): ${missing}${NC}"
    log_error "   ${RED}  Grant the missing permission(s) on the API key in Honeycomb, or set a key-specific override in .skaffold.env${NC}"
    return 1
  fi

  log "   ${GREEN}✓ ${label} key valid — Team: $team_name, Environment: $env_name, perms: ${perms_csv}${NC}"
  echo "$body"
  return 0
}

# auth_identity <body> — return "team_slug/env_slug" from a /1/auth response.
auth_identity() {
  echo "$1" | jq -r '"\(.team.slug // "")/\(.environment.slug // "")"'
}

if [ -z "$INGEST_KEY" ] && [ -z "$MARKER_KEY" ]; then
  log_error "   ${RED}✗ No Honeycomb keys set. Set HONEYCOMB_API_KEY (or HONEYCOMB_INGEST_KEY + HONEYCOMB_MARKERS_KEY) in .skaffold.env${NC}"
  errors=$((errors + 1))
elif [ "$INGEST_KEY" = "$MARKER_KEY" ]; then
  # Same key serves both purposes — one HTTP call, both perms asserted.
  # Team/env equality is trivially satisfied.
  auth_check "$INGEST_KEY" "events,markers" "Ingest+Marker" >/dev/null || errors=$((errors + 1))
else
  ingest_body=$(auth_check "$INGEST_KEY" "events" "Ingest") || ingest_body=""
  [ -z "$ingest_body" ] && errors=$((errors + 1))

  marker_body=$(auth_check "$MARKER_KEY" "markers" "Marker") || marker_body=""
  [ -z "$marker_body" ] && errors=$((errors + 1))

  # Markers must be posted to the same team+environment that the spans land
  # in, otherwise they appear on the wrong board with no spans behind them.
  if [ -n "$ingest_body" ] && [ -n "$marker_body" ]; then
    ingest_id=$(auth_identity "$ingest_body")
    marker_id=$(auth_identity "$marker_body")
    if [ "$ingest_id" != "$marker_id" ]; then
      log_error "   ${RED}✗ Ingest key (${ingest_id}) and Marker key (${marker_id}) point to different team/environment${NC}"
      log_error "   ${RED}  Markers must be posted to the same env the spans land in. Use keys from the same Honeycomb environment.${NC}"
      errors=$((errors + 1))
    fi
  fi
fi

log ""
log "=============================================="

if [ $errors -gt 0 ]; then
  log_error "${RED}Validation failed with $errors error(s)${NC}"
  exit 1
else
  log "${GREEN}All validations passed!${NC}"
  exit 0
fi
