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
Port forwarding service/frontend-proxy in namespace martin-local, remote port 8080 -> http://127.0.0.1:9191
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
AWS_PROFILE=devrel-sandbox ./run accounting checkout frontend frontendproxy payment postgresql shipping storechat
```

## Querying telemetry from the local cluster

The local cluster (namespace `martin-local`) ships directly to Honeycomb using `HONEYCOMB_API_KEY` from `.skaffold.env`. The key determines the destination team + environment — **don't guess which env to query**. Resolve it from the key with the Honeycomb auth API before running any MCP query:

```bash
curl -s https://api.honeycomb.io/1/auth \
  -H "X-Honeycomb-Team: $(grep HONEYCOMB_API_KEY .skaffold.env | cut -d= -f2)" \
  | jq '{team: .team.slug, environment: .environment.slug}'
```

The returned `environment.slug` is what to pass to the matching honeycomb MCP server's `environment_slug` argument (the team determines which MCP server — `martindotnet-pro`, `devrel-demo`, etc.).
