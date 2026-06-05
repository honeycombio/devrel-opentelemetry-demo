# Claude Code Project Notes

## Building and Deploying

### Local Kubernetes deployment via Skaffold

Use the `./run` script to build and deploy services:

```bash
AWS_PROFILE=devrel-sandbox ./run <service1> <service2> ...
```

Service names match the `image:` entries in `skaffold.yaml` (e.g. `accounting`, `frontend`, `frontendproxy`, `storechat`).

**Which services to pass as args:** only the ones whose source has changed between your branch and the last release. Every `./run` invocation deploys the full Helm chart, but services not listed in the args fall back to the chart's default image — which is the registry's released `latest-*` tag (already has the most recent merged code), not the OTel-upstream image. They don't need rebuilding.

In practice: diff against the last release (typically `main`), pick only the services with source changes under `src/<service>` (or `deploy/config-files/custom-collector` for the `otelcollector` image), and pass those. Config-only changes (Helm values, collector YAML *referenced by* skaffold-config/) ride along on the chart deploy and don't need any image rebuild.

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

## Querying telemetry from the local cluster

The local cluster (namespace `martin-local`) ships directly to Honeycomb using `HONEYCOMB_API_KEY` from `.skaffold.env`. The key determines the destination team + environment — **don't guess which env to query**. Resolve it from the key with the Honeycomb auth API before running any MCP query:

```bash
curl -s https://api.honeycomb.io/1/auth \
  -H "X-Honeycomb-Team: $(grep HONEYCOMB_API_KEY .skaffold.env | cut -d= -f2)" \
  | jq '{team: .team.slug, environment: .environment.slug}'
```

The returned `environment.slug` is what to pass to the matching honeycomb MCP server's `environment_slug` argument (the team determines which MCP server — `martindotnet-pro`, `devrel-demo`, etc.).

## Production cluster access

The shared/"production" demo runs on the **`devrel-demo-aws`** kubectl context (EKS, account `657166037864`, eu-west-1; pulumi stack `infra-aws/prod`). Authenticate with `AWS_PROFILE=really-devrel-sandbox` — that profile maps to account `657166037864`. (The plain `devrel-sandbox` profile may have no creds locally; `set-kubecontext.sh` defaults to it but the *prod* account is `really-devrel-sandbox`.)

The production **app deployment lives in the `devrel-demo` namespace**. The `*-local` namespaces (`jessitron-local`, `martin-local`, etc.) are per-developer Skaffold deploys, and `orion` is a separate cluster (us-west-2, different account).

```bash
AWS_PROFILE=really-devrel-sandbox kubectl --context devrel-demo-aws -n devrel-demo get pods
```

## Querying order / customer data (the order store)

Orders flow: **checkout → Kafka `orders` topic → accounting service → Postgres**. The system of record is the Postgres table `accounting."order"` (schema `accounting`; note `order` is reserved so it must be quoted). Columns include `order_id`, `email`, `user_id`, `transaction_id`, `total_cost_*`, `order_status`, `created_at`. Sibling tables: `accounting.orderitem`, `accounting.shipping`. Defined in `src/accounting/Entities.cs`; persisted in `src/accounting/Consumer.cs`.

Postgres lives in the `postgresql` pod (label `app.kubernetes.io/name=postgresql`): database `otel`, superuser `root`/`otel` (the app connects as `otelu`/`otelp` — both reach the same DB). Pod name has a generated suffix, so resolve it by label.

`scripts/query-production-order-emails.sh` does this end-to-end (finds the pod, prints order totals + emails). It's all demo/synthetic data, no real PII.

**Gotcha — orders depend on Kafka being healthy.** The accounting consumer only persists orders it reads from the Kafka `orders` topic. If the `kafka` pod is crash-looping (check `RESTARTS` in `get pods`), the consumer logs `2/2 brokers are down` / `topic orders does not exist` and the `accounting.order` table stays **empty** even though checkout may still be taking orders. An empty order table usually means "Kafka is down," not "nobody ordered." In that case, order emails are only visible in checkout telemetry (Honeycomb), not the DB.
