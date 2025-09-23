#!/bin/sh

set -e
echo "Extracting js sourcemaps"

# check all environment variables have been set
if [ -z "$REPO" ]; then
  echo "REPO environment variable not set"
  exit 1
fi
if [ -z "$CONTAINER_PATH" ]; then
  echo "CONTAINER_PATH environment variable not set"
  exit 1
fi
if [ -z "$BLOB_CONTAINER_NAME" ]; then
  echo "BLOB_CONTAINER_NAME environment variable not set"
  exit 1
fi
if [ -z "$STORAGE_ACCOUNT_NAME" ]; then
  echo "STORAGE_ACCOUNT_NAME environment variable not set"
  exit 1
fi
if [ -z "$VERSION" ]; then
  echo "VERSION not set, so using \"latest\""
  VERSION=latest
fi

TEMP_PATH=$(mktemp -d)
echo "Using temporary path $TEMP_PATH"


docker run -d --name frontend-container $REPO:$VERSION-frontend
docker cp frontend-container:$CONTAINER_PATH $TEMP_PATH
docker rm -f frontend-container

## upload

az storage blob upload-batch -d $BLOB_CONTAINER_NAME -s $TEMP_PATH --account-name $STORAGE_ACCOUNT_NAME --auth-mode login --overwrite > /dev/null

