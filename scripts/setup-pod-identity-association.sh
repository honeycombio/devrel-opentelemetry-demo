#!/bin/sh

set -e
echo "Setting up EKS Pod Identity Association"

# Usage: setup-pod-identity-association.sh [--cluster-name NAME] [--namespace NS] [--service-account SA] [--role-arn ARN]
# Command line arguments override environment variables

while [ $# -gt 0 ]; do
  case "$1" in
    --cluster-name)
      CLUSTER_NAME="$2"
      shift 2
      ;;
    --namespace)
      NAMESPACE="$2"
      shift 2
      ;;
    --service-account)
      SERVICE_ACCOUNT="$2"
      shift 2
      ;;
    --role-arn)
      ROLE_ARN="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1"
      echo "Usage: $0 [--cluster-name NAME] [--namespace NS] [--service-account SA] [--role-arn ARN]"
      exit 1
      ;;
  esac
done

# Fetch values from pulumi if not provided
if [ -z "$CLUSTER_NAME" ]; then
  echo "CLUSTER_NAME not set, fetching from pulumi stack output"
  CLUSTER_NAME=$(pulumi stack output -s honeycomb-devrel/infra-aws/prod clusterName 2>/dev/null)
fi

if [ -z "$ROLE_ARN" ]; then
  echo "ROLE_ARN not set, fetching from pulumi stack output"
  ROLE_ARN=$(pulumi stack output -s honeycomb-devrel/infra-aws/prod s3RoleArn 2>/dev/null)
fi

# Default service account names (space-separated list)
if [ -z "$SERVICE_ACCOUNT" ]; then
  SERVICE_ACCOUNTS="otel-collector $USER-htp-htp-builder-primary-collector"
else
  SERVICE_ACCOUNTS="$SERVICE_ACCOUNT"
fi

# Check required parameters
if [ -z "$NAMESPACE" ]; then
  echo "NAMESPACE not set (use --namespace or NAMESPACE env var)"
  exit 1
fi

# Expand environment variables in parameters
NAMESPACE=$(eval echo "$NAMESPACE")
CLUSTER_NAME=$(eval echo "$CLUSTER_NAME")
ROLE_ARN=$(eval echo "$ROLE_ARN")

# Function to create or update pod identity association for a service account
setup_association() {
  local sa_name="$1"
  sa_name=$(eval echo "$sa_name")

  echo "Creating pod identity association: $sa_name"

  # Check if association already exists
  EXISTING=$(aws eks list-pod-identity-associations \
    --cluster-name "$CLUSTER_NAME" \
    --namespace "$NAMESPACE" \
    --service-account "$sa_name" \
    --query 'associations[0].associationId' \
    --output text 2>/dev/null || echo "None")

  if [ "$EXISTING" != "None" ] && [ -n "$EXISTING" ]; then
    echo "Pod identity association already exists (ID: $EXISTING), updating..."
    aws eks update-pod-identity-association \
      --cluster-name "$CLUSTER_NAME" \
      --association-id "$EXISTING" \
      --role-arn "$ROLE_ARN" > /dev/null
  else
    echo "Creating new pod identity association..."
    aws eks create-pod-identity-association \
      --cluster-name "$CLUSTER_NAME" \
      --namespace "$NAMESPACE" \
      --service-account "$sa_name" \
      --role-arn "$ROLE_ARN" > /dev/null
  fi

  echo "Pod identity association configured successfully for $sa_name"
  echo ""
}

# Process each service account
for sa in $SERVICE_ACCOUNTS; do
  setup_association "$sa"
done

echo "All pod identity associations configured successfully"

