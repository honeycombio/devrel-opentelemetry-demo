#!/bin/bash

eval "$(pulumi stack output --shell --cwd ./scripts)"

echo "Logging into ACR $acrName"
export ACRNAME=$acrName.azyurecr.io
az acr login --name $acrName