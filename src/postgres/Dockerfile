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

# Directory for Postgres's structured (jsonlog) log file; entrypoint.sh tails it to stdout.
RUN mkdir -p /var/log/postgresql && chown postgres:postgres /var/log/postgresql

COPY ./src/postgres/entrypoint.sh /usr/local/bin/postgres-entrypoint.sh
COPY ./src/postgres/init.sql /docker-entrypoint-initdb.d/init.sql
COPY ./src/postgres/auth-seed.sql /docker-entrypoint-initdb.d/zz-auth-seed.sql

EXPOSE ${POSTGRES_PORT}

ENTRYPOINT ["postgres-entrypoint.sh"]

# Logging: every statement is logged (with its duration) as one JSON object per
# line. Clients append a SQLCommenter comment, e.g. /*traceparent='00-<trace>-<span>-01'*/,
# which ends up in the logged statement so the collector can attach the trace
# context to the log record. compute_query_id adds `query_id` to each entry.
# The OTLP endpoint and service name for opentelemetry_postgres come from the
# OTEL_EXPORTER_OTLP_ENDPOINT and OTEL_SERVICE_NAME environment variables.
CMD ["postgres", \
     "-c", "shared_preload_libraries=pg_cron,opentelemetry_postgres", \
     "-c", "cron.database_name=otel", \
     "-c", "logging_collector=on", \
     "-c", "log_destination=jsonlog", \
     "-c", "log_directory=/var/log/postgresql", \
     "-c", "log_filename=postgresql.log", \
     "-c", "log_rotation_size=10MB", \
     "-c", "log_truncate_on_rotation=on", \
     "-c", "log_min_duration_statement=0", \
     "-c", "compute_query_id=on"]
