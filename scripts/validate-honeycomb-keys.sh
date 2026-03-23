#!/bin/bash

#
# validate-honeycomb-keys.sh
# Validates the Honeycomb API key in .skaffold.env
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
log "Validating Honeycomb API Key"
log "=============================================="
log ""

if [ -z "$HONEYCOMB_API_KEY" ]; then
  log_error "   ${RED}✗ HONEYCOMB_API_KEY is not set${NC}"
  errors=$((errors + 1))
else
  response=$(curl -s -w "\n%{http_code}" -H "X-Honeycomb-Team: $HONEYCOMB_API_KEY" \
                   "https://api.honeycomb.io/1/auth")

  http_code=$(echo "$response" | tail -n1)
  body=$(echo "$response" | sed '$d')

  if [ "$http_code" != "200" ]; then
    log_error "   ${RED}✗ Failed to authenticate with HONEYCOMB_API_KEY (HTTP $http_code)${NC}"
    log_error "   ${RED}  Response: $body${NC}"
    errors=$((errors + 1))
  else
    env_name=$(echo "$body" | jq -r '.environment.name // "classic"')
    team_name=$(echo "$body" | jq -r '.team.name // empty')
    log "   ${GREEN}✓ API key is valid (Team: $team_name, Environment: $env_name)${NC}"
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
