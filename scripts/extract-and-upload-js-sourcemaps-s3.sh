#!/bin/sh

set -e
echo "Extracting js sourcemaps"

# Usage: extract-and-upload-js-sourcemaps-s3.sh [--repo REPO] [--container-path PATH] [--bucket BUCKET] [--prefix PREFIX] [--version VERSION]
# Command line arguments override environment variables

while [ $# -gt 0 ]; do
  case "$1" in
    --repo)
      REPO="$2"
      shift 2
      ;;
    --container-path)
      CONTAINER_PATH="$2"
      shift 2
      ;;
    --bucket)
      S3_BUCKET="$2"
      shift 2
      ;;
    --prefix)
      S3_PREFIX="$2"
      shift 2
      ;;
    --version)
      VERSION="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1"
      echo "Usage: $0 [--repo REPO] [--container-path PATH] [--bucket BUCKET] [--prefix PREFIX] [--version VERSION]"
      exit 1
      ;;
  esac
done

# Check all required parameters have been set (via env vars or command line)
if [ -z "$REPO" ]; then
  echo "REPO not set (use --repo or REPO env var)"
  exit 1
fi
if [ -z "$CONTAINER_PATH" ]; then
  echo "CONTAINER_PATH not set (use --container-path or CONTAINER_PATH env var)"
  exit 1
fi
if [ -z "$S3_BUCKET" ]; then
  echo "S3_BUCKET not set, fetching from pulumi stack output"
  S3_BUCKET=$(pulumi stack output -s honeycomb-devrel/infra-aws/prod s3BucketName)
fi
if [ -z "$S3_PREFIX" ]; then
  # Use SOURCE_MAPS_PREFIX env var if set, otherwise fetch from pulumi
  if [ -n "$SOURCE_MAPS_PREFIX" ]; then
    S3_PREFIX="$SOURCE_MAPS_PREFIX"
  else
    echo "S3_PREFIX not set, fetching from pulumi stack output"
    S3_PREFIX=$(pulumi stack output -s honeycomb-devrel/infra-aws/prod s3BucketPrefix)
  fi
fi
if [ -z "$VERSION" ]; then
  echo "VERSION not set, so using \"latest\""
  VERSION=latest
fi

# Expand environment variables in parameters
REPO=$(eval echo "$REPO")
CONTAINER_PATH=$(eval echo "$CONTAINER_PATH")
S3_BUCKET=$(eval echo "$S3_BUCKET")
S3_PREFIX=$(eval echo "$S3_PREFIX")
VERSION=$(eval echo "$VERSION")

TEMP_PATH=$(mktemp -d)
echo "Using temporary path $TEMP_PATH"

# Construct the full image name based on cloud provider
# ECR format: <account>.dkr.ecr.<region>.amazonaws.com/<repo>-frontend:<tag>
# Other format: <repo>:<tag>-frontend
if [ "$CLOUD_PROVIDER" = "aws" ]; then
  # ECR: the repo already includes the image name, tag is separate
  IMAGE="$REPO/frontend:$VERSION"
else
  # GHCR/other: tag includes the suffix
  IMAGE="$REPO:$VERSION-frontend"
fi

echo "Using image: $IMAGE"
docker run -d --name frontend-container $IMAGE
docker cp frontend-container:$CONTAINER_PATH $TEMP_PATH
docker rm -f frontend-container

## upload

if [ -n "$S3_PREFIX" ]; then
  aws s3 sync $TEMP_PATH s3://$S3_BUCKET/$S3_PREFIX --delete
else
  aws s3 sync $TEMP_PATH s3://$S3_BUCKET --delete
fi

