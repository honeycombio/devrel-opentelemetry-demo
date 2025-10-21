# OpenTelemetry Conventions Documentation Generation

This document describes how to generate and serve documentation for the OpenTelemetry custom attributes registry using a 2-stage Docker build process.

## Overview

The documentation generation system uses:

1. **Stage 1 - Weaver Generator**: Uses the OpenTelemetry Weaver container to generate Markdown documentation from the registry.yaml file
2. **Stage 2 - MkDocs Server**: Serves the generated documentation using MkDocs with the Material theme

## Architecture

### Two-Stage Docker Build

```
┌─────────────────────────────────────────────────────────────┐
│ Stage 1: otel/weaver:latest                                 │
├─────────────────────────────────────────────────────────────┤
│ • Copies registry.yaml                                      │
│ • Runs: weaver registry update-markdown                     │
│ • Outputs: /docs/generated/attributes.md                    │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ Stage 2: python:3.12-slim                                   │
├─────────────────────────────────────────────────────────────┤
│ • Installs mkdocs and mkdocs-material                       │
│ • Copies generated docs from Stage 1                        │
│ • Creates mkdocs.yml configuration                          │
│ • Exposes port 8000                                         │
│ • Runs: mkdocs serve                                        │
└─────────────────────────────────────────────────────────────┘
```

## Files

### Dockerfile.docs
Two-stage Dockerfile that:
- Uses `otel/weaver:latest` to generate Markdown from registry.yaml
- Uses `python:3.12-slim` to serve documentation with mkdocs
- Includes health checks and proper signal handling

### docker-compose.docs.yml
Docker Compose configuration for local development:
- Mounts registry.yaml for live updates
- Exposes port 8000
- Includes health checks
- Auto-restart on failure

### scripts/build-docs.sh
Bash script to build and optionally run the documentation:
- Validates registry.yaml exists
- Builds Docker image
- Provides multiple run options

## Usage

### Option 1: Using Make (Recommended)

Build the documentation image:
```bash
make docs-build
```

Run the documentation server:
```bash
make docs-run
```

Run with docker-compose:
```bash
make docs-compose
```

Stop the docker-compose server:
```bash
make docs-compose-down
```

Clean up documentation artifacts:
```bash
make docs-clean
```

### Option 2: Using the Build Script

Build only:
```bash
./scripts/build-docs.sh
```

Build and run:
```bash
./scripts/build-docs.sh --run
```

Build and run with docker-compose:
```bash
./scripts/build-docs.sh --compose
```

### Option 3: Using Docker Directly

Build the image:
```bash
docker build -f Dockerfile.docs -t otel-conventions-docs:latest .
```

Run the container:
```bash
docker run -p 8000:8000 otel-conventions-docs:latest
```

Run with volume mount for live updates:
```bash
docker run -p 8000:8000 \
  -v $(pwd)/src/conventions/registry.yaml:/workspace/registry.yaml:ro \
  otel-conventions-docs:latest
```

### Option 4: Using Docker Compose

Start the services:
```bash
docker-compose -f docker-compose.docs.yml up
```

Stop the services:
```bash
docker-compose -f docker-compose.docs.yml down
```

## Accessing the Documentation

Once the server is running, access the documentation at:

```
http://localhost:8000
```

The documentation includes:
- Home page with overview
- Generated attributes documentation from registry.yaml
- Search functionality
- Responsive Material theme

## Development Workflow

### Live Updates During Development

When using docker-compose or the volume mount option, the registry.yaml is mounted as read-only. To see updates:

1. Modify `src/conventions/registry.yaml`
2. Rebuild the documentation:
   ```bash
   docker build -f Dockerfile.docs -t otel-conventions-docs:latest .
   ```
3. Restart the container to regenerate the markdown

### Customizing the Documentation

Edit the mkdocs configuration in `Dockerfile.docs`:
- Modify the `mkdocs.yml` section to change site settings
- Edit the `index.md` section to customize the home page
- Add additional markdown files to the `docs/` directory

## Generated Output

The documentation generation produces:

```
docs/
├── index.md                    # Home page
├── generated/
│   └── attributes.md          # Generated from registry.yaml
└── mkdocs.yml                 # MkDocs configuration
```

## Performance Considerations

### Image Size
- Stage 1 (Weaver): ~500MB
- Stage 2 (Python + MkDocs): ~200MB
- Final image: ~200MB (only Stage 2 is kept)

### Build Time
- First build: ~2-3 minutes (downloading base images)
- Subsequent builds: ~30-60 seconds

### Runtime
- Container startup: ~2-3 seconds
- Documentation generation: ~1-2 seconds
- Memory usage: ~100-150MB

## Troubleshooting

### Port Already in Use
If port 8000 is already in use:
```bash
docker run -p 8001:8000 otel-conventions-docs:latest
```

### Registry File Not Found
Ensure `src/conventions/registry.yaml` exists:
```bash
ls -la src/conventions/registry.yaml
```

### Weaver Command Failed
Check the Weaver documentation:
```bash
docker run --rm otel/weaver:latest weaver --help
```

### MkDocs Server Not Starting
Check logs:
```bash
docker logs otel-conventions-docs
```

## Integration with CI/CD

### GitHub Actions Example

```yaml
- name: Build Documentation
  run: make docs-build

- name: Push Documentation Image
  run: |
    docker tag otel-conventions-docs:latest \
      ghcr.io/${{ github.repository }}/otel-conventions-docs:latest
    docker push ghcr.io/${{ github.repository }}/otel-conventions-docs:latest
```

### Kubernetes Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: otel-conventions-docs
spec:
  replicas: 1
  selector:
    matchLabels:
      app: otel-conventions-docs
  template:
    metadata:
      labels:
        app: otel-conventions-docs
    spec:
      containers:
      - name: docs
        image: otel-conventions-docs:latest
        ports:
        - containerPort: 8000
        livenessProbe:
          httpGet:
            path: /
            port: 8000
          initialDelaySeconds: 5
          periodSeconds: 10
```

## Next Steps

1. Build the documentation: `make docs-build`
2. Run the server: `make docs-run`
3. Access at http://localhost:8000
4. Customize as needed for your deployment

## References

- [OpenTelemetry Weaver](https://github.com/open-telemetry/weaver)
- [MkDocs Documentation](https://www.mkdocs.org/)
- [MkDocs Material Theme](https://squidfunk.github.io/mkdocs-material/)
- [Docker Multi-stage Builds](https://docs.docker.com/build/building/multi-stage/)

