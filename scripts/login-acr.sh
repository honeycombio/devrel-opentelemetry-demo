#!/bin/bash

# commenting out to save 3s every time I run this
# this changes almost never
# eval "$(pulumi stack output --shell --cwd ./scripts)"
acrName=mainacra1e0ec0b

echo "Logging into ACR $acrName"
export ACRNAME=$acrName.azyurecr.io
az acr login --name $acrName
