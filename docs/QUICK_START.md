# Documentation Generation - Quick Start

Get the OpenTelemetry conventions documentation running in 30 seconds.

## Prerequisites

- Docker
- Docker Compose (optional)
- Make (optional)

## 30-Second Start

```bash
make docs-run
```

Then open: **http://localhost:8000**

## Alternative Methods

### Using Docker Compose

```bash
make docs-compose
```

### Using Docker Directly

```bash
docker build -f Dockerfile.docs -t otel-conventions-docs:latest .
docker run -p 8000:8000 otel-conventions-docs:latest
```

### Using the Build Script

```bash
./scripts/build-docs.sh --run
```

## Common Commands

| Task | Command |
|------|---------|
| Build image | `make docs-build` |
| Run server | `make docs-run` |
| Run with compose | `make docs-compose` |
| Stop compose | `make docs-compose-down` |
| Clean up | `make docs-clean` |

## What You Get

- 📖 Full documentation of all custom attributes
- 🔍 Full-text search
- 📱 Responsive design
- ⚡ Fast navigation
- 🎨 Professional Material theme

## Accessing Documentation

Once running, the documentation is available at:

```
http://localhost:8000
```

## Stopping the Server

### If using `make docs-run`
```bash
Ctrl+C
```

### If using `make docs-compose`
```bash
make docs-compose-down
```

### If using Docker directly
```bash
docker stop otel-conventions-docs
```

## Troubleshooting

### Port 8000 Already in Use

```bash
docker run -p 8001:8000 otel-conventions-docs:latest
```

Then access at: `http://localhost:8001`

### Registry File Not Found

```bash
ls -la src/conventions/registry.yaml
```

### Container Won't Start

```bash
docker logs otel-conventions-docs
```

## Next Steps

1. ✅ Start the server: `make docs-run`
2. ✅ Open http://localhost:8000
3. ✅ Browse the documentation
4. ✅ Use search to find attributes
5. ✅ Read the detailed guide: `docs/DOCUMENTATION_GENERATION.md`

## For Development

### Live Updates

Mount the registry file to see updates:

```bash
docker run -p 8000:8000 \
  -v $(pwd)/src/conventions/registry.yaml:/workspace/registry.yaml:ro \
  otel-conventions-docs:latest
```

After updating `src/conventions/registry.yaml`, rebuild:

```bash
make docs-build
```

## For Production

### Build and Push to Registry

```bash
docker build -f Dockerfile.docs -t myregistry/otel-conventions-docs:latest .
docker push myregistry/otel-conventions-docs:latest
```

### Deploy to Kubernetes

See `DOCUMENTATION_GENERATION.md` for Kubernetes deployment example.

## Documentation Structure

```
docs/
├── QUICK_START.md                  # This file
├── README.md                       # Overview and guide
├── DOCUMENTATION_GENERATION.md     # Detailed guide
├── index.md                        # Home page (generated)
└── generated/
    └── attributes.md              # Generated from registry.yaml
```

## More Information

- **Quick Overview**: `docs/README.md`
- **Detailed Guide**: `docs/DOCUMENTATION_GENERATION.md`
- **Registry Format**: `src/conventions/README.md`
- **Weaver Documentation**: https://github.com/open-telemetry/weaver
- **MkDocs Documentation**: https://www.mkdocs.org/

## Support

For detailed troubleshooting and advanced usage, see:
- `docs/DOCUMENTATION_GENERATION.md` - Comprehensive guide
- `docs/README.md` - Overview and features

---

**That's it!** You now have a fully functional documentation server for your OpenTelemetry conventions registry.

