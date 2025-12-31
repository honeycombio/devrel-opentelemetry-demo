# Copyright The OpenTelemetry Authors
# SPDX-License-Identifier: Apache-2.0

# Stage 1: Generate documentation using OpenTelemetry Weaver
FROM otel/weaver:latest AS docs-generator

WORKDIR /workspace

# Copy the registry file
COPY ./model /workspace/

# Create output directory for generated docs
RUN mkdir -p /workspace/output

# Generate markdown documentation from the registry using weaver
RUN /weaver/weaver registry generate markdown \
    --registry=/workspace \
    --templates=https://github.com/open-telemetry/semantic-conventions/archive/refs/tags/v1.32.0.zip[templates] \
    /workspace/output

# Stage 2: Serve documentation with mkdocs
FROM python:3.12-slim

WORKDIR /app

# Install mkdocs and theme
RUN pip install --no-cache-dir \
    mkdocs==1.5.3 \
    mkdocs-material==9.5.3

COPY --from=docs-generator /workspace/output /app/docs
COPY --from=docs-generator /workspace/output /tmp

# Copy mkdocs configuration and docs
COPY mkdocs.yml /app/mkdocs.yml

# Expose port for mkdocs
EXPOSE 8000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000')" || exit 1

# Start mkdocs server
CMD ["mkdocs", "serve", "--dev-addr", "0.0.0.0:8000"]

