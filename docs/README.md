# OpenTelemetry Conventions Documentation

This directory contains documentation for the OpenTelemetry custom attributes and metrics registry.

## Quick Start

### Build and Run Documentation Server

```bash
# Using Make (recommended)
make docs-run

# Or using docker-compose
make docs-compose

# Or using the build script
./scripts/build-docs.sh --run
```

Then access the documentation at: **http://localhost:8000**

## Directory Structure

```
docs/
├── README.md                           # This file
├── DOCUMENTATION_GENERATION.md         # Detailed generation guide
├── index.md                            # Home page (generated)
├── generated/
│   └── attributes.md                   # Generated from registry.yaml
└── mkdocs.yml                          # MkDocs configuration (generated)
```

## What's Included

### Generated Documentation

The documentation is automatically generated from `src/conventions/registry.yaml` using OpenTelemetry Weaver:

- **Attributes Documentation**: Complete reference of all custom span attributes
- **Metrics Documentation**: Reference of all custom metrics
- **Examples**: Usage examples for each attribute
- **Service Mapping**: Which services use which attributes

### Features

- 📱 **Responsive Design**: Works on desktop, tablet, and mobile
- 🔍 **Full-Text Search**: Quickly find attributes and metrics
- 🎨 **Material Theme**: Modern, professional appearance
- 📖 **Offline Support**: Documentation works offline
- ⚡ **Fast Navigation**: Instant page loads

## Building Documentation

### Prerequisites

- Docker and Docker Compose
- Make (optional, but recommended)
- ~500MB disk space for Docker images

### Build Options

#### Option 1: Make (Recommended)

```bash
# Build the image
make docs-build

# Run the server
make docs-run

# Or use docker-compose
make docs-compose

# Stop docker-compose
make docs-compose-down

# Clean up
make docs-clean
```

#### Option 2: Docker Compose

```bash
docker-compose -f docker-compose.docs.yml up
```

#### Option 3: Docker Directly

```bash
docker build -f Dockerfile.docs -t otel-conventions-docs:latest .
docker run -p 8000:8000 otel-conventions-docs:latest
```

#### Option 4: Build Script

```bash
./scripts/build-docs.sh --run
```

## Development

### Live Updates

When developing, you can mount the registry file to see updates:

```bash
docker run -p 8000:8000 \
  -v $(pwd)/src/conventions/registry.yaml:/workspace/registry.yaml:ro \
  otel-conventions-docs:latest
```

### Customizing Documentation

Edit the mkdocs configuration in `Dockerfile.docs`:

1. Modify the `mkdocs.yml` section for site settings
2. Edit the `index.md` section for home page content
3. Add additional markdown files to `docs/` directory

### Regenerating Documentation

After updating `src/conventions/registry.yaml`:

```bash
# Rebuild the image
make docs-build

# Restart the container
make docs-run
```

## Deployment

### Docker Hub

```bash
docker tag otel-conventions-docs:latest myregistry/otel-conventions-docs:latest
docker push myregistry/otel-conventions-docs:latest
```

### GitHub Container Registry

```bash
docker tag otel-conventions-docs:latest ghcr.io/myorg/otel-conventions-docs:latest
docker push ghcr.io/myorg/otel-conventions-docs:latest
```

### Kubernetes

See `DOCUMENTATION_GENERATION.md` for a Kubernetes deployment example.

## Troubleshooting

### Port 8000 Already in Use

```bash
docker run -p 8001:8000 otel-conventions-docs:latest
```

### Registry File Not Found

```bash
ls -la src/conventions/registry.yaml
```

### Container Won't Start

Check logs:
```bash
docker logs otel-conventions-docs
```

### Weaver Generation Failed

Verify the registry.yaml is valid YAML:
```bash
docker run --rm -v $(pwd):/workspace otel/weaver:latest \
  weaver registry validate /workspace/src/conventions/registry.yaml
```

## Architecture

### Two-Stage Build

1. **Stage 1 - Weaver**: Generates Markdown from registry.yaml
2. **Stage 2 - MkDocs**: Serves the generated documentation

This approach:
- ✅ Keeps final image small (~200MB)
- ✅ Separates concerns (generation vs. serving)
- ✅ Enables caching of dependencies
- ✅ Follows Docker best practices

### Image Layers

```
otel/weaver:latest (Stage 1)
  ↓
  Generate attributes.md
  ↓
python:3.12-slim (Stage 2)
  ↓
  Install mkdocs + material
  ↓
  Copy generated docs
  ↓
  Create mkdocs.yml
  ↓
  Final image (~200MB)
```

## Performance

- **Build Time**: 30-60 seconds (after first build)
- **Startup Time**: 2-3 seconds
- **Memory Usage**: 100-150MB
- **Image Size**: ~200MB

## CI/CD Integration

### GitHub Actions

The repository includes a GitHub Actions workflow (`.github/workflows/build-docs.yml`) that:

- Builds the documentation image on push to main
- Validates the registry.yaml
- Pushes to GitHub Container Registry
- Runs on pull requests (without pushing)

### Manual Trigger

```bash
# Trigger the workflow manually
gh workflow run build-docs.yml
```

## Related Documentation

- [OpenTelemetry Weaver](https://github.com/open-telemetry/weaver)
- [MkDocs Documentation](https://www.mkdocs.org/)
- [MkDocs Material Theme](https://squidfunk.github.io/mkdocs-material/)
- [Registry YAML Format](../src/conventions/README.md)
- [Detailed Generation Guide](./DOCUMENTATION_GENERATION.md)

## Support

For issues or questions:

1. Check `DOCUMENTATION_GENERATION.md` for detailed troubleshooting
2. Review the registry.yaml format in `src/conventions/README.md`
3. Check Docker logs: `docker logs otel-conventions-docs`
4. Validate registry: `docker run --rm -v $(pwd):/workspace otel/weaver:latest weaver registry validate /workspace/src/conventions/registry.yaml`

## License

Copyright The OpenTelemetry Authors
SPDX-License-Identifier: Apache-2.0

