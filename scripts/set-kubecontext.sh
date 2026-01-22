#!/bin/bash

# Default to AWS if no flag is provided
CLOUD_PROVIDER="${1:-aws}"
NO_PROFILE=false

# Check for --no-profile flag
if [[ "$2" == "--no-profile" ]]; then
    NO_PROFILE=true
fi

# Validate the cloud provider argument
if [[ ! "$CLOUD_PROVIDER" =~ ^(aws|azure)$ ]]; then
    echo "Error: Invalid cloud provider '$CLOUD_PROVIDER'"
    echo "Usage: $0 [aws|azure] [--no-profile]"
    echo "Default: aws"
    exit 1
fi

if [[ "$CLOUD_PROVIDER" == "aws" ]]; then
    if [[ "$NO_PROFILE" == "false" ]] && [[ -z "$AWS_PROFILE" ]]; then
        echo "Using Profile 'devrel-sandbox' as AWS_PROFILE isn't set"
        export AWS_PROFILE=devrel-sandbox
    fi
    eval "$(pulumi stack output -s honeycomb-devrel/infra-aws/prod --shell)"
    echo "Setting kubectl context to $clusterName in $clusterRegion (AWS)"
    aws eks update-kubeconfig --name "$clusterName" --region "$clusterRegion" --alias devrel-demo-aws
elif [[ "$CLOUD_PROVIDER" == "azure" ]]; then
    eval "$(pulumi stack output -s honeycomb-devrel/infra-azure/prod --shell)"
    echo "Setting kubectl context to $clusterName in $clusterResourceGroup (Azure)"
    az aks get-credentials -n "$clusterName" -g "$clusterResourceGroup" --overwrite-existing --context devrel-demo-azure
fi