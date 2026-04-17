# Copyright The OpenTelemetry Authors
# SPDX-License-Identifier: Apache-2.0

FROM postgres:17.6

RUN apt-get update && apt-get install -y --no-install-recommends postgresql-17-cron && rm -rf /var/lib/apt/lists/*

COPY ./src/postgres/init.sql /docker-entrypoint-initdb.d/init.sql

EXPOSE ${POSTGRES_PORT}

CMD ["postgres", "-c", "shared_preload_libraries=pg_cron", "-c", "cron.database_name=otel"]
