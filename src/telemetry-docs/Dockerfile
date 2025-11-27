# Two-stage build: Generate Markdown from Weaver config, then serve with mkdocs

# Stage 1: Generate Markdown files from Weaver registry
# Note: We use a builder image to generate the docs, then copy them to the final stage
FROM otel/weaver:latest AS weaver-builder

WORKDIR /workspace

# Copy the telemetry schema
COPY telemetry-schema /workspace/telemetry-schema

RUN /weaver/weaver registry generate markdown \
    --registry /workspace/telemetry-schema \
    --templates https://github.com/open-telemetry/semantic-conventions/archive/refs/tags/v1.38.0.zip[templates] \
    /workspace/docs

# Stage 2: Serve documentation with mkdocs
FROM python:3.11-slim

WORKDIR /app

# Install mkdocs and theme
RUN pip install --no-cache-dir mkdocs mkdocs-material

# Copy mkdocs configuration from src/telemetry-docs
COPY src/telemetry-docs/mkdocs.yml /app/mkdocs.yml

# Copy generated documentation from stage 1
COPY --from=weaver-builder /workspace/docs /app/docs

# Expose port for mkdocs
EXPOSE 8000

# Serve documentation
CMD ["mkdocs", "serve", "--dev-addr", "0.0.0.0:8000"]

