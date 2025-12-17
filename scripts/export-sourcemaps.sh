#!/bin/sh
cd scripts
FRONTEND_CONTAINER=frontend FRONTEND_LABEL=app.kubernetes.io/component=frontend NAMESPACE=kenrimple-local ./upload_frontend_static_chunks.sh s3://kenrimple-devrel-demo-symbolication/maps
cd ..
