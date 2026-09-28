# Claude Code Project Notes

This is the DevRel OpenTelemetry Demo project. Our job is to "make it real" -- to make concrete demonstrations of everything Marketing says about the Honeycomb product. We use this project to create data in Honeycomb, so that people and agents in Honeycomb can make insightful deductions about what is happening in production.

This is a fork of the OpenTelemetry Demo. It's a fake e-commerce app.

## jessitron/slow-login-story branch

Right here, on this branch, we are adding some code to let me tell a story.
The goal is to show off Canvas Connectors. There's a long path to get there.
I want to create a story here, with real code, not a feature flag that turns on a pathology.

To start with, let's add a "Login" feature to the website. We don't require anyone to log in,
the usual checkout process & loadgen remains the same. The 'user' But we offer login for corporate accounts, see.

Then we'll make login suddenly very slow for a subset of users. Like only SSO accounts, excluding our biggest customer.

For this branch, find further plans under notes/user-login-story.md

## Building and Deploying

### Local Kubernetes deployment via Skaffold

Use the `./run` script to build and deploy services:

```bash
AWS_PROFILE=devrel-sandbox ./run <service1> <service2> ...
```

Service names match the `image:` entries in `skaffold.yaml` (e.g. `accounting`, `frontend`, `frontendproxy`, `storechat`).

**Which services to pass as args:** only the ones whose source has changed between your branch and the last release. Every `./run` invocation deploys the full Helm chart, but services not listed in the args fall back to the chart's default image — which is the registry's released `latest-*` tag (already has the most recent merged code), not the OTel-upstream image. They don't need rebuilding.

In practice: diff against the last release (typically `main`), pick only the services with source changes under `src/<service>` (or `deploy/config-files/custom-collector` for the `otelcollector` image), and pass those. Config-only changes (Helm values, collector YAML _referenced by_ skaffold-config/) ride along on the chart deploy and don't need any image rebuild.

### How to know when it's done

The `./run` script blocks on `skaffold run --port-forward`. Look for this line in the output to confirm deployment is complete:

```
Port forwarding service/frontend-proxy in namespace martin-local, remote port 8080 -> http://127.0.0.1:9191
Press Ctrl+C to exit
```

The port number (9191, 9192, etc.) increments if a previous port-forward is still bound. Use whatever port is shown.

### Collector configuration: local vs. production

For **local dev deployments** (`{user}-local` via `./run`), the collector
config is in `skaffold-config/demo-values.yaml` — Skaffold passes it to
Helm as a values override. The files under `deploy/config-files/collector/`
are for the **production cluster** (`devrel-demo` namespace on EKS) only.

### Common issues

- **Multiple skaffold processes**: If previous runs are still alive (holding port-forwards), kill them before starting a new run. Check with `ps aux | grep skaffold`.
- **AWS credentials**: The script sources `.skaffold.env` which sets `AWS_PROFILE=devrel-sandbox`. If running in a context where env vars aren't inherited, pass `AWS_PROFILE=devrel-sandbox` explicitly.
- **Docker must be running**: Skaffold uses Docker to build images. Start Docker before running.

## Expected gaps in traces (don't go hunting)

**flagd feature-flag spans are dropped at the collector, deliberately.**
`filter/drop_flagd_spans` removes anything with
`rpc.service == "flagd.evaluation.v1.Service"`, anything from
`service.name == "flagd"`, and anything with `server.address == "flagd"`. The
rule is duplicated in two places, so change both:
`deploy/config-files/collector/values-daemonset.yaml` (production) and
`skaffold-config/demo-values.yaml` (local `*-local` deploys).

That third condition exists because **cart is .NET, where `Grpc.Net.Client`
rides on `HttpClient`, so one flagd lookup produces two nested spans**: the
gRPC-client span (`flagd.evaluation.v1.Service/ResolveBoolean`) and a
`System.Net.Http` child named `POST`. Only the parent carries `rpc.*`, so the
original rule dropped the parent and left the child orphaned — a `POST` span
whose `trace.parent_id` never arrives, ~119k/day. You can't turn the double
span off in-app: `SuppressDownstreamInstrumentation` stopped working at
`OpenTelemetry.Instrumentation.Http` 1.6.0 and we're on 1.14.0.

Cart's instrumentation is correct (`AddHttpClientInstrumentation()` and
`AddGrpcClientInstrumentation()` in `src/cart/src/Program.cs`) — verified with a
standalone repro on the same package versions, which emits both spans. We filter
in the collector rather than removing instrumentation from cart, to avoid fork
drift in a file we sync from upstream and to avoid silently blinding any future
HTTP call cart makes.

Note the `feature_flag.evaluation` span event stays on the _calling_ span
(OpenFeature's `TraceEnricherHook` writes to `Activity.Current`), so flag data
is never lost — only the RPC spans are.

**`meta.span_count` on the root won't match what you count.** Refinery stamps it
at decision time; spans that arrive afterwards show up with
`meta.refinery.send_reason: trace_send_late_span` and are _not_ in that count.

## Cutting a release (deploying to devrel-demo/prod)

See `devrel-README.md` → "Deploy to devrel-demo" for the full writeup. Short version: `./scripts/bump-release.sh patch` tags and pushes, which triggers `.github/workflows/release-devrel.yml` to build images _and_ deploy to the `prod-aws` Pulumi stack automatically — no manual `pulumi up` needed. To redeploy an existing version without rebuilding, use the `deploy-with-version.yml` workflow instead.

## Querying telemetry from the local cluster

The local cluster (namespace `{user}-local`) ships directly to Honeycomb. The key determines the destination team + environment — **don't guess which env to query**. Resolve it before running any MCP query:

```bash
scripts/local-honeycomb-destination.sh
```

It resolves the key the way `./run` does: source `.skaffold.env`, then `HONEYCOMB_INGEST_KEY`, falling back to `HONEYCOMB_API_KEY`. **Don't grep `.skaffold.env` for the key** — it's often exported in the developer's shell instead (Jess keeps it in a personal, git-excluded `.be` file), so the file may not contain it at all.

The returned `environment.slug` is what to pass as `environment_slug`; the team determines which MCP server. For Jess, it's team `modernity`, env `devrel-demo--local-`, via the `honeycomb-devrel-demo` MCP server with `team: "modernity"`. (Martin's goes to `martindotnet-pro`.)
## Production cluster access

The shared/"production" demo runs on the **`devrel-demo-aws`** kubectl context (EKS, account `657166037864`, eu-west-1; pulumi stack `infra-aws/prod`). Authenticate with `AWS_PROFILE=really-devrel-sandbox` — that profile maps to account `657166037864`. (The plain `devrel-sandbox` profile may have no creds locally; `set-kubecontext.sh` defaults to it but the _prod_ account is `really-devrel-sandbox`.)

The production **app deployment lives in the `devrel-demo` namespace**. The `*-local` namespaces (`jessitron-local`, `martin-local`, etc.) are per-developer Skaffold deploys, and `orion` is a separate cluster (us-west-2, different account).

```bash
AWS_PROFILE=really-devrel-sandbox kubectl --context devrel-demo-aws -n devrel-demo get pods
```

## Querying order / customer data (the order store)

Orders flow: **checkout → Kafka `orders` topic → accounting service → Postgres**. The system of record is the Postgres table `accounting."order"` (schema `accounting`; note `order` is reserved so it must be quoted). Columns include `order_id`, `email`, `user_id`, `transaction_id`, `total_cost_*`, `order_status`, `created_at`. Sibling tables: `accounting.orderitem`, `accounting.shipping`. Defined in `src/accounting/Entities.cs`; persisted in `src/accounting/Consumer.cs`.

Postgres lives in the `postgresql` pod (label `app.kubernetes.io/name=postgresql`): database `otel`, superuser `root`/`otel` (the app connects as `otelu`/`otelp` — both reach the same DB). Pod name has a generated suffix, so resolve it by label.

`scripts/query-production-order-emails.sh` does this end-to-end (finds the pod, prints order totals + emails). It's all demo/synthetic data, no real PII.

**Gotcha — orders depend on Kafka being healthy.** The accounting consumer only persists orders it reads from the Kafka `orders` topic. If the `kafka` pod is crash-looping (check `RESTARTS` in `get pods`), the consumer logs `2/2 brokers are down` / `topic orders does not exist` and the `accounting.order` table stays **empty** even though checkout may still be taking orders. An empty order table usually means "Kafka is down," not "nobody ordered." In that case, order emails are only visible in checkout telemetry (Honeycomb), not the DB.
