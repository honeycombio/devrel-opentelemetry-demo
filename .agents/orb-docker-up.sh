#!/usr/bin/env bash
# Makes sure a Docker daemon is running in an Amp orb. Orbs ship dockerd but do
# not start it. It runs as a supervised orb service so it survives Amp CLI
# updates and orb pause/resume. Idempotent and quick when Docker is already up.
#
# --group root: the orb user is in group 0, so it can use the socket without sudo.
# --insecure-registry: the k3d registry (.agents/orb-run) speaks plain HTTP.
set -euo pipefail

if docker info >/dev/null 2>&1; then
  exit 0
fi

amp orb service start docker \
  --command 'exec sudo dockerd --group root --insecure-registry k3d-registry.localhost:5000' >/dev/null

for _ in $(seq 1 60); do
  if docker info >/dev/null 2>&1; then
    exit 0
  fi
  sleep 1
done
echo "Docker did not come up in 60s; see: amp orb service logs docker" >&2
exit 1
