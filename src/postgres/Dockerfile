# Copyright The OpenTelemetry Authors
# SPDX-License-Identifier: Apache-2.0

# Server-side query spans: https://github.com/practical-otel/opentelemetry-postgres
# A Postgres extension that reads the SQLCommenter traceparent our clients add to
# each query and sends a SERVER span, parented to the client's DB span, to the
# collector over OTLP. Pinned to a commit because the project has no releases yet.
FROM postgres:17.6 AS otel-postgres
ARG OTEL_POSTGRES_REF=89e15412bbc51d0b28d20b21d6a7ebbe5ab34b70
RUN apt-get update && apt-get install -y --no-install-recommends build-essential postgresql-server-dev-17 \
    && rm -rf /var/lib/apt/lists/*
ADD https://github.com/practical-otel/opentelemetry-postgres/archive/${OTEL_POSTGRES_REF}.tar.gz /tmp/src.tar.gz
RUN mkdir /src && tar -xzf /tmp/src.tar.gz -C /src --strip-components=1
WORKDIR /src
RUN make && make install DESTDIR=/out

FROM postgres:17.6

COPY --from=otel-postgres /out/ /
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
