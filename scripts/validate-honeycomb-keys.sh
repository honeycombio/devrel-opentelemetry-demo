#!/bin/bash

#
# validate-honeycomb-keys.sh
# Validates the Honeycomb API keys in .skaffold.env:
# - Ensures the pipeline ingest key is for an environment named "Pipeline Telemetry"
# - Ensures the pipeline management key has required permissions
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
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Helper function for quiet mode
log() {
  if [ "$QUIET" = false ]; then
    echo -e "$@"
  fi
}

log_error() {
  echo -e "$@"
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

errors=0

log "=============================================="
log "Validating Honeycomb API Keys"
log "=============================================="
log ""

# =====================================================
# Validate Pipeline Telemetry Ingest Key
# =====================================================
log "1. Validating Pipeline Telemetry Ingest Key..."

if [ -z "$PIPELINE_TELEMETRY_INGEST_KEY" ]; then
  log_error "   ${RED}✗ PIPELINE_TELEMETRY_INGEST_KEY is not set${NC}"
  errors=$((errors + 1))
else
  # Call /1/auth to get environment info
  response=$(curl -s -w "\n%{http_code}" -H "X-Honeycomb-Team: $PIPELINE_TELEMETRY_INGEST_KEY" \
                   "https://api.honeycomb.io/1/auth")

  http_code=$(echo "$response" | tail -n1)
  body=$(echo "$response" | sed '$d')

  if [ "$http_code" != "200" ]; then
    log_error "   ${RED}✗ Failed to authenticate with ingest key (HTTP $http_code)${NC}"
    log_error "   ${RED}  Response: $body${NC}"
    errors=$((errors + 1))
  else
    env_name=$(echo "$body" | jq -r '.environment.name // empty')
    team_name=$(echo "$body" | jq -r '.team.name // empty')

    if [ -z "$env_name" ]; then
      log_error "   ${RED}✗ Could not extract environment name from response${NC}"
      log_error "   ${YELLOW}  (This may be a Classic environment without environment names)${NC}"
      errors=$((errors + 1))
    elif [ "$env_name" != "Pipeline Telemetry" ]; then
      log_error "   ${RED}✗ Environment name mismatch${NC}"
      log_error "   ${RED}  Expected: 'Pipeline Telemetry'${NC}"
      log_error "   ${RED}  Actual:   '$env_name'${NC}"
      errors=$((errors + 1))
    else
      log "   ${GREEN}✓ Ingest key is for environment: '$env_name' (Team: $team_name)${NC}"
    fi
  fi
fi

log ""

# =====================================================
# Validate Pipeline Management Key
# =====================================================
log "2. Validating Pipeline Management Key..."

if [ -z "$PIPELINE_MANAGEMENT_API_KEY_ID" ] || [ -z "$PIPELINE_MANAGEMENT_API_SECRET" ]; then
  log_error "   ${RED}✗ PIPELINE_MANAGEMENT_API_KEY_ID or PIPELINE_MANAGEMENT_API_SECRET is not set${NC}"
  errors=$((errors + 1))
else
  # Construct the bearer token
  bearer_token="${PIPELINE_MANAGEMENT_API_KEY_ID}:${PIPELINE_MANAGEMENT_API_SECRET}"

  # Call /2/auth to get management key info
  response=$(curl -s -w "\n%{http_code}" -H "Authorization: Bearer $bearer_token" \
                   "https://api.honeycomb.io/2/auth")

  http_code=$(echo "$response" | tail -n1)
  body=$(echo "$response" | sed '$d')

  if [ "$http_code" != "200" ]; then
    log_error "   ${RED}✗ Failed to authenticate with management key (HTTP $http_code)${NC}"
    log_error "   ${RED}  Response: $body${NC}"
    errors=$((errors + 1))
  else
    key_name=$(echo "$body" | jq -r '.data.attributes.name // "unnamed"')
    scopes=$(echo "$body" | jq -r '.data.attributes.scopes // []')

    log "   Key name: $key_name"
    log "   Scopes: $scopes"

    # Required scopes for pipeline operations
    required_scopes=("api-keys:write" "environments:read" "pipelines:write")
    missing_scopes=()

    for scope in "${required_scopes[@]}"; do
      if ! echo "$scopes" | jq -e "index(\"$scope\")" > /dev/null 2>&1; then
        missing_scopes+=("$scope")
      fi
    done

    if [ ${#missing_scopes[@]} -gt 0 ]; then
      log_error "   ${RED}✗ Missing required scopes:${NC}"
      for scope in "${missing_scopes[@]}"; do
        log_error "   ${RED}  - $scope${NC}"
      done
      errors=$((errors + 1))
    else
      log "   ${GREEN}✓ Management key has all required scopes${NC}"
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
