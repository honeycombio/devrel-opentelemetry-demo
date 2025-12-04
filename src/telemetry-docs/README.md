# OpenTelemetry Demo Telemetry Documentation

This directory contains the Docker setup for generating and serving OpenTelemetry telemetry schema documentation using Weaver and mkdocs.

## Overview

The Dockerfile uses a **two-stage build process** without Aspire dependencies:

### Stage 1: Weaver Generator (`otel/weaver:latest`)
- Loads the telemetry schema from `telemetry-schema/`
- Generates Markdown documentation from YAML configuration files
- Generates the mkdocs navigation file `mkdocs.yml`

### Stage 2: mkdocs Server (`python:3.11-slim`)
- Installs mkdocs and Material theme
- Copies generated Markdown files from Stage 1
- Serves documentation on port 8000 with live reload

## Running locally

### Build the Image

```bash
docker build -t otel-demo-telemetry-docs:latest -f src/telemetry-docs/Dockerfile .
```

### Run the Container

```bash
docker run -p 8000:8000 otel-demo-telemetry-docs:latest
```

Visit `http://localhost:8000/telemetry-docs/` in your browser.


## Generated Documentation Structure

```
docs/
├── index.md                    # Overview
├── services/                  # One file per service including metrics and attributes
│   ├── accounting.md           # Accounting service documentation
│   ├── email.md                # Email service documentation
|   ├── payment.md              # Payment service documentation
│   └── ...                     # Other services
├── attributes/                # One file per logical attribute group
│   ├── product.md              # Product attributes
│   ├── user.md                 # User attributes
│   ├── order.md                # Order attributes
│   └── ...                     # Other attribute groups
└── schema.json                # resolved schema as JSON
```

