# Claude Code Project Notes

## Building and Deploying

### Local Kubernetes deployment via Skaffold

Use the `./run` script to build and deploy services:

```bash
AWS_PROFILE=devrel-sandbox ./run <service1> <service2> ...
```

Service names match the `image:` entries in `skaffold.yaml` (e.g. `accounting`, `frontend`, `frontendproxy`, `storechat`).

**Important:** Every `./run` invocation deploys the full Helm chart. Services not listed in the arguments revert to their default upstream images. Always include ALL services that need custom-built images.

### How to know when it's done

The `./run` script blocks on `skaffold run --port-forward`. Look for this line in the output to confirm deployment is complete:

```
Port forwarding service/frontend-proxy in namespace ${USER}-local, remote port 8080 -> http://127.0.0.1:9191
Press Ctrl+C to exit
```

The port number (9191, 9192, etc.) increments if a previous port-forward is still bound. Use whatever port is shown.

### Common issues

- **Multiple skaffold processes**: If previous runs are still alive (holding port-forwards), kill them before starting a new run. Check with `ps aux | grep skaffold`.
- **AWS credentials**: The script sources `.skaffold.env` which sets `AWS_PROFILE=devrel-sandbox`. If running in a context where env vars aren't inherited, pass `AWS_PROFILE=devrel-sandbox` explicitly.
- **Docker must be running**: Skaffold uses Docker to build images. Start Docker before running.

### Changed services on this branch

When deploying this branch, include all services with code changes:

```bash
AWS_PROFILE=devrel-sandbox ./run accounting checkout frontend frontendproxy llm-evals payment postgresql product-reviews shipping storechat
```

`llm-evals` and `product-reviews` are repo-local services with no upstream image — omitting them deploys an empty/stale image and silently breaks the eval pipeline.
