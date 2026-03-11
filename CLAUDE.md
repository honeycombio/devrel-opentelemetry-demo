# Claude Code Project Notes

This is the OpenTelemetry Demo application - a microservices-based eCommerce system used for demonstrating observability patterns.

## Building and Deploying Services

To build and deploy a single service to your personal namespace (`$USER-local`):

```
./run <service-name>
```

Example: `./run cart` builds the Docker image, pushes to ECR, and deploys via skaffold.

Uses skaffold under the hood. Requires ECR login (the script handles this automatically).

Note: ECR repos must already exist. If you get "repository does not exist" errors, the repo needs to be created first.

## Infrastructure

- Deployed via **Pulumi** from `deploy/` directory. Two stacks: `prod` and `prod-aws`. AWS stack is active (`devrel-demo-aws` kubeconfig context)
- Run `AWS_REGION=eu-west-1 pulumi up --yes -s honeycomb-devrel/prod-aws` from `deploy/` to apply infra changes
- EKS cluster is in **eu-west-1** (10x t3.xlarge nodes)
- May need `pulumi install` if node_modules are missing in `deploy/`
- `deploy/.tool-versions` sets nodejs version for asdf
- Each person's namespace is `$USER-local`, deployed URL is `https://$USER-local.aurelia.honeydemo.io`

## Telemetry Pipeline Architecture

```
Services → Daemonset Collector → HTP (Honeycomb Telemetry Pipeline) → Refinery → Honeycomb
                               → dogfood Honeycomb (traces)
                               → BindPlane node agent (traces + logs)
```

- **Daemonset collector** config: `deploy/config-files/collector/values-daemonset.yaml`
- **Cluster collector** config: `deploy/config-files/collector/values-deployment.yaml`
- **HTP**: deployed via `htp-builder` Helm chart, endpoint passed as `HTP_ENDPOINT` env var
- **BindPlane**: see `deploy/config-files/bindplane/`

## Feature Flags (flagd)

- Flag definitions source: `src/flagd/demo.flagd.json`
- Deployed ConfigMap often drifts from source (missing flags). Use `scripts/patch-flagd-configmap.sh <namespace>` to sync.
- `scripts/set-flag-percentage.sh <pct> [namespace]` adjusts `cartservice.add-db-call` rollout percentage.
- `scripts/flag-dbcall-off.sh [namespace]` — patches ConfigMap + sets flag to 0% + restarts flagd. Called by `./run`.
- `scripts/flag-dbcall-on.sh [namespace]` — sets flag to 50% + restarts flagd. Run manually when ready to demo.
- **Important**: After updating a ConfigMap, you must restart flagd — kubelet takes 60-90s to propagate ConfigMap changes to mounted volumes, so just updating the ConfigMap is not enough for immediate effect.
- The flagd UI (at `/feature` on the demo URL) only supports simple on/off toggles, not fractional targeting.
- For fractional evaluation, flagd requires `targetingKey` to be set in the OpenFeature evaluation context. Setting properties like `app.user.id` is NOT enough — must use `.SetTargetingKey()` explicitly.

## Observability Notes

- Services instrument using OpenTelemetry with custom `app.*` attributes
- OpenFeature tracing hook emits feature flag evaluations as **span events** (not span attributes). These are separate billable events in Honeycomb and remove high-fidelity data from the span. ~50% of cart dataset events are span events.
- Look for `feature_flag.key`, `feature_flag.result.variant` columns — but they're on span events, not the parent spans.
