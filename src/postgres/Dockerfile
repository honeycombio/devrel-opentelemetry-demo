# Copyright The OpenTelemetry Authors
# SPDX-License-Identifier: Apache-2.0

# Server-side query spans: https://github.com/practical-otel/opentelemetry-postgres
# A Postgres extension that reads the SQLCommenter traceparent our clients add to
# each query and sends a SERVER span, parented to the client's DB span, to the
# collector over OTLP. Download the prebuilt release for this Postgres major
# version and CPU (`uname -m` is x86_64 or aarch64, matching the release names).
FROM docker.io/library/alpine:3.22 AS otel-postgres
ARG OTEL_POSTGRES_VERSION=0.1.0
RUN name=opentelemetry-postgres-${OTEL_POSTGRES_VERSION}-pg17-linux-$(uname -m)-glibc \
    && wget -qO- https://github.com/practical-otel/opentelemetry-postgres/releases/download/v${OTEL_POSTGRES_VERSION}/${name}.tar.gz \
       | tar -xz -C /tmp \
    && mv /tmp/${name} /tmp/otel-postgres

FROM postgres:17.6

COPY --from=otel-postgres /tmp/otel-postgres/opentelemetry_postgres.so /usr/lib/postgresql/17/lib/
COPY --from=otel-postgres /tmp/otel-postgres/opentelemetry_postgres.control /tmp/otel-postgres/opentelemetry_postgres--*.sql /usr/share/postgresql/17/extension/

RUN apt-get update && apt-get install -y --no-install-recommends postgresql-17-cron && rm -rf /var/lib/apt/lists/*

COPY ./src/postgres/init.sql /docker-entrypoint-initdb.d/init.sql
COPY ./src/postgres/auth-seed.sql /docker-entrypoint-initdb.d/zz-auth-seed.sql

EXPOSE ${POSTGRES_PORT}

# The OTLP endpoint and service name for opentelemetry_postgres come from the
# OTEL_EXPORTER_OTLP_ENDPOINT and OTEL_SERVICE_NAME environment variables.
# compute_query_id lets the extension record postgresql.query.id on its spans.
CMD ["postgres", \
     "-c", "shared_preload_libraries=pg_cron,opentelemetry_postgres", \
     "-c", "cron.database_name=otel", \
     "-c", "compute_query_id=on"]
