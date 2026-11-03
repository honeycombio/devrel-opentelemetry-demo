# Running the demo in an Amp orb

[Amp orbs](https://ampcode.com/docs/orbs) can run the whole demo in a k3d (k3s in Docker) cluster, with no AWS, EKS or Pulumi:

```shell
.agents/orb-run [--all] [service ...]
```

This is `./run` for orbs. It starts Docker, creates a k3d cluster named `orb` with a local registry, then runs `skaffold run -p orb` (see the `orb` profile in `skaffold.yaml` and `.agents/orb-values.yaml`). Like `./run`, only the services you name are built from source; the rest use the released `latest-*` images. `--all` builds everything. It then port-forwards `frontend-proxy` and prints a portal URL.

- **Orb size:** the whole demo needs an `a1.large` (8 CPU, 16 GB) or bigger orb; it uses about 5 GB with released images. `--all` builds all 27 services in about 15 minutes on an `a1.large` (peak about 10 GB). Set `ORB_BUILD_CONCURRENCY` to build more in parallel on a bigger orb.
- **Honeycomb:** add a Honeycomb ingest key (events and markers permissions) as a *personal* Amp secret named `DEVREL_OTEL_DEMO_HONEYCOMB_API_KEY`, in Amp Settings → Secrets & Env Vars, or by asking the agent to set it (it opens a masked dialog, so the key never enters the thread). It is private to you and only this repo reads that name; `.agents/orb-run` deliberately ignores `HONEYCOMB_API_KEY`, which may point at another team. Then run `amp orb restart-processes` (a new orb picks it up on its own) and re-run `.agents/orb-run`. Without the key the demo runs but telemetry goes nowhere, and `.agents/orb-run` prints instructions for the agent to relay.
- **What differs from `./run`:** no ALB ingress, no Pod Identity, and the collector doesn't upload to S3. Bedrock isn't reachable, so `llm-evals` is off, and `store-chat` can't answer.
- **AWS:** the orb can reach the demo's EKS cluster and ECR in account 657166037864 with no AWS keys or SSO login, the same way Autobots orbs do. The `default`, `devrel-sandbox` and `really-devrel-sandbox` AWS profiles use `.agents/aws-credential-process`, which exchanges an [Amp OIDC token](https://ampcode.com/manual/orbs/oidc) for the `amp-orb-devrel-otel-demo` role (defined in devrel-opentelemetry-demo-infra, `infra-aws/amp-orb-access.ts`). That role can push to the `localdemo/*` ECR repos and is cluster-admin on the EKS cluster; `.agents/resume` adds its `devrel-demo-aws` kubectl context without making it current. It has no Bedrock access. `.agents/pulumi-login` (run by `.agents/resume`) logs Pulumi in to `honeycomb-devrel` as the DevRel team the same way, through an OIDC issuer registered in that org, for 12 hours at a time. With both, `./run` works from an orb against the shared EKS cluster.
- `.agents/setup` installs the tools (helm, kubectl, skaffold, k3d, buildx) and pre-pulls the k3d images. `.agents/resume` starts Docker when an orb wakes.
