#!/bin/bash

eval "$(pulumi stack output --shell --cwd ./scripts)"

echo "Setting kubectl context to $clusterName in $clusterResourceGroup"
az aks get-credentials -n $clusterName -g $clusterResourceGroup --overwrite-existing --context devrel-azure