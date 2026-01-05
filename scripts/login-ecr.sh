#!/bin/bash

set -e

# Get ECR registry from Pulumi stack output
ECR_REGISTRY=$(pulumi stack output -s honeycomb-devrel/infra-aws/prod ecrRepositoryUrl)

# Extract the account ID and region from the registry URL
# Format: <account-id>.dkr.ecr.<region>.amazonaws.com
ACCOUNT_ID=$(echo "$ECR_REGISTRY" | cut -d. -f1)
REGION=$(echo "$ECR_REGISTRY" | cut -d. -f4)

echo "Logging into ECR registry: $ECR_REGISTRY"

# Login to ECR
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$ECR_REGISTRY"

echo "Successfully logged into ECR"

