#!/bin/sh
# Copyright The OpenTelemetry Authors
# SPDX-License-Identifier: Apache-2.0

# Postgres only writes jsonlog output to files (it needs logging_collector).
# Mirror that file to stdout so container log collection (filelog receiver in
# k8s, `docker logs` in compose) picks up one JSON object per line.
# `tail -F` waits for the file to appear and follows rotation/truncation.
tail -F -n 0 /var/log/postgresql/postgresql.json 2>/dev/null &

exec docker-entrypoint.sh "$@"
