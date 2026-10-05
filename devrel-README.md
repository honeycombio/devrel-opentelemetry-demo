# DevRel Instance of the OpenTelemetry Demo

There are 2 versions of the demo running. One is in AWS EKS, the other in Azure AKS. Along with local versions for each team member in the same clusters.

The local version can be deployed to either cloud, and is self-contained entirely.

## Anatomy of the instances

All instances include:

- Otel Demo
- OpenTelemetry Collectors
  - Daemonset
    > This is for filelogs, kubeletstats and OTLP ingest from the services
  - Deployment
    > This is for k8s events, and cluster metrics
- Refinery / Honeycomb
  > The collectors export straight to Refinery and `api.honeycomb.io`.

For all instances, OTLP ingest comes through the use of a k8s service rather than a NodeIP. This enables multiple instances of the demo to run in the same cluster, each with their own collector instances.

### AWS

On AWS, we use the ALB ingress controller to provide a public URL for the frontend-proxy service. Then we use external-dns via Route53 to create a domain under aurelia.honeydemo.io. This uses the wildcard certificate for \*.aurelia.honeydemo.io for the ALB.

There are 2 ALBs, one of them is shared for the local instances, the other is dedicated to the main instance.

### Azure

On Azure, we use the webapprouting addon for AKS to provide a public URL for the frontend-proxy service. Then we use external-dns via Azure DNS to create a domain under zurelia.honeydemo.io.

Additionally, we use cert-manager and letsencrypt to provide a TLS certificate for the frontend-proxy service.

## Setup for Local Development

Regardless of the cloud, you'll need the following installed.

- [kubectl](https://kubernetes.io/docs/tasks/tools/install-kubectl/)
- [helm](https://helm.sh/docs/intro/install/)
- [skaffold](https://skaffold.dev/docs/installation/)
- [pulumi](https://www.pulumi.com/docs/get-started/install/)

You'll also need access to our Pulumi Cloud.

## Honeycomb Setup

Local deploys export telemetry straight to Honeycomb. You need a Honeycomb API key with `events` and
`markers` permission for whichever team/environment you want your `{user}-local`
data to land in.

## .skaffold.env setup

`./run` sources `.skaffold.env` if it exists, then reads `HONEYCOMB_API_KEY` from the
environment. You can put the key in `.skaffold.env` or export it in your shell; either works.

```bash
export HONEYCOMB_API_KEY=
# optional per-purpose overrides; both default to HONEYCOMB_API_KEY
# export HONEYCOMB_INGEST_KEY=
# export HONEYCOMB_MARKERS_API_KEY=
```

To see where your local telemetry will land, run `scripts/local-honeycomb-destination.sh`.
It resolves the key the same way `./run` does and prints the team + environment.

`HONEYCOMB_MARKERS_API_KEY` is what `./run` uses to post a Honeycomb deploy marker
after each local skaffold run (via `scripts/create-local-deploy-marker.sh`).
It needs `markers` permission on whichever team/environment your telemetry
lands in — if it's missing, `./run` still deploys, it just logs a warning and
skips the marker. If unset, it falls back to `HONEYCOMB_API_KEY`.
`scripts/validate-honeycomb-keys.sh` checks both keys have the right
permissions and point at the same environment.

## AWS Setup

You'll need to have the following installed:

- [aws cli](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)
- A Credential profile with access to the AWS DevRel Sandbox account
  Cut and paste: https://houndsh.slack.com/archives/C039LR4TQ0Z/p1767971921140419

## Azure Setup

<!-- TODO: Add instructions for Azure CLI and authentication -->

## Skaffold

```shell
./run
```

## Setup for DevRel

Be a member of our Honeycomb Devrel Azure account, or the AWS DevRel Sandox account

There is another repo, devrel-opentelemetry-infra, that sets up the AKS and EKS clusters.
It also creates a container registry (ACR/ECR) and links the two together, so that the clusters can pull from the image repositories.
However, when we deploy things ourselves using skaffold, we're pushing them to ACR/ECR.

The OpenTelemetry collector is deployed by this repo. For application telemetry, it uses a service instead of Martin's favorite nodeIP, because we want multiples in the cluster sending to different Honeycomb environments. This is doing something weird, because we are devrel and we do weird things.

The collector config is not where you think it is!! Your collector config is in skaffold-config/demo-values.yaml

QUESTION for Martin: how do you get skaffold to redeploy only the collector?

The real collector config (for the public-facing demo) is in deploy/config-files/collector/values-daemonset.yaml

## The public one

When we do CI, in github actions, that pushes release images to GHCR instead. (that was easier, they can be public we don't care)

For now,
We can deploy those with ./deploy, which is a pulumi thinger for deploying this demo from GHCR to AKS.
Some one else could modify that and deploy to their cluster, since the images are public.

Currently, this is available at www.zurelia.honeydemo.io
This is the public one that we will keep and up and usable. That pushes Honeycomb data to the devrel-demos team, azure-otel-demo environment.

This version gets the cluster-level collector data, with kubernetes events. This is deployed in ./deploy

The k8s namespace for this one is devrel-demo.

## Demo stories

Some scenarios in this repo are stories: real code, shipped through ordinary PRs and releases, that behaves
badly in production. There is no feature flag that turns on a pathology. The point is to have a genuine incident in
Honeycomb for people and agents to investigate.

### Slow login (Canvas Connectors)

Shows an incident being traced back to a recent code change, using the Linear, GitHub and incident.io connectors in a
Honeycomb Canvas.

**The setup (on `main`):**

- The `auth` service and the frontend Login link ([PR #42](https://github.com/honeycombio/devrel-opentelemetry-demo/pull/42)).
  Login is optional; checkout and loadgen don't need it. Corporate accounts sign in with a password or through a mocked
  SSO provider (`sso-mocks`).
- Our biggest customer, Globex, asked for a post-SSO check that the employee is still current
  ([PR #43](https://github.com/honeycombio/devrel-opentelemetry-demo/pull/43), Linear DVR-121). It shipped behind the
  flagd flag `auth.user-status-check`, targeted at Globex only. Tenants that haven't configured a status URL get
  `https://sso-status.<company-domain>/v1/users/<id>` by default, which is unreachable for every tenant except Globex.
  Only Globex has `enforce = true`, so for everyone else the check fails open: the login succeeds, after a 10s timeout.

**The trigger:** [PR #44, "Remove stale feature flags"](https://github.com/honeycombio/devrel-opentelemetry-demo/pull/44)
(Linear DVR-122). It looks like routine cleanup, but it deletes the Globex targeting, so the status check runs for
every SSO login. Once the release containing it is live (`2.9.3-release` was the first), non-Globex SSO logins take
about 10s longer. Password logins and Globex are unaffected.

**What you see in Honeycomb** (auth dataset, after the deploy marker):

- `oteldemo.AuthService/Login`: P95 `duration_ms` goes from about 130ms to about 10s, grouped by `app.auth.method` and
  `app.company`. About 40% of logins are affected, and login volume drops because loadgen users block.
- `CheckUserStatus` spans: `app.auth.status_check.result = error`, `app.auth.status_check.enforced = false`, P95 about
  10s. Use `parent.app.company` to group by company.
- The Honeycomb trigger "Login latency check" (P95 of Login `duration_ms` > 500) sends a webhook to incident.io, which
  opens an incident within a couple of 5-minute evaluations.

**Current state:** PR #44 was reverted on `main` (`43de817b`), so `main` is healthy: the flag and its Globex
targeting are back. `2.9.3-release` shipped the broken version once, for the first recording.

**To trigger it (for example, to record another video):**

1. Let prod run healthy for a while, so the Canvas has a boring "before". (If the release running in prod still includes
   PR #44, first release the revert, or redeploy an older version with the `deploy-with-version.yml` workflow.)
2. Revert the revert on `main` (`git revert 43de817b`, ideally through a PR titled like the original, "Remove stale
   feature flags"), then cut a release: `./scripts/bump-release.sh patch --yes`. The incident starts as soon as the new
   `auth` pod is live; the code no longer asks flagd, so nothing else is needed.
3. Check the incident is open in incident.io with a severity, and that the connectors can see Linear DVR-121 and
   DVR-122, GitHub PRs #43 and #44 with their diffs, and the incident. Then open the Canvas and ask "Check on the latest
   changes I made. Could they have caused this?"

To put it back, release the revert again, or run `deploy-with-version.yml` with the previous version (no rebuild).

To try it locally, deploy with `./run auth frontend sso-mocks` from a commit with or without PR #44's change.

## Iteration

We can deploy from local to the cluster in a new namespace, using `skaffold`
It defaults to GHCR (release) images, but will build local images and pushes them to ACR.

It'll use your HONEYCOMB_API_KEY env var to send telemetry data with its own collector. (You won't get cluster-level events).

### Install skaffold

```shell
curl -Lo skaffold https://storage.googleapis.com/skaffold/releases/latest/skaffold-linux-amd64 && \
sudo install skaffold /usr/local/bin/
```

or on macOS

```shell
brew install skaffold
```

### Install azure-cli

```shell
brew update && brew install azure-cli
```

### log in to azure

```shell
az login
```

If you get `Error when retrieving token from sso: Token has expired and refresh failed`, then... it's probably trying to connect to EKS, and I should run `k config use-context devrel-azure` (because that's the name of my context for this cluster)

### log in to pulumi

This is only needed if you're going to deploy to the main demo! To run in your own namespace, you don't have to do this.

```shell
pulumi login
pulumi stack select honeycomb-devrel/prod
```

### get

### connect to k8s

```shell
./scripts/set-kubecontext.sh
```

### (optional) see what's going on in k8s

Run `k9s`

Type `:context`

Choose devrel-azure

Type `:namespace`

Choose all

### log in to ACR

```shell
./scripts/login-acr.sh
```

This outputs the azure container registry name
#TODO create

### run skaffold

cheat:

```shell
./run cartservice
```

... which does the stuff below:

where acrName is the name of the azure container registry, TODO make that easy

and cartservice is a comma-separated list of services to build locally.

and yourkey is an ingest key; you can use devrel-demo/development env if you want.

```shell
export HONEYCOMB_API_KEY=yourkey
skaffold run -d <azure container registry name>.azurecr.io -b cartservice --port-forward=user -l skaffold.dev/run-id=static
```

QUESTION: is `acrName` the thing

It makes a whole yourname-local namespace with all the stuff in it.

### shut down your iterative environment

```shell
skaffold delete
```

## eBPF Instrumentation (OBI)

We run [OpenTelemetry eBPF Instrumentation (OBI)](https://opentelemetry.io/docs/zero-code/obi/) to get kernel-level traces for services in the cluster without code changes. Config is in `kubernetes/helm-obi.yml`.

### Install / upgrade

```shell
helm repo add open-telemetry https://open-telemetry.github.io/opentelemetry-helm-charts
helm install obi open-telemetry/opentelemetry-ebpf-instrumentation -n obi --create-namespace -f kubernetes/helm-obi.yml
# or to upgrade:
helm upgrade obi open-telemetry/opentelemetry-ebpf-instrumentation -n obi -f kubernetes/helm-obi.yml
```

### Excluding services

eBPF instruments everything in the `devrel-demo` namespace by default. We exclude Refinery (and its Redis) because eBPF traces go through Refinery, creating a feedback loop: Refinery generates traces that Refinery then processes, which generates more traces, etc.

Exclusions are in `kubernetes/helm-obi.yml` under `discovery.exclude_instrument`. If you add other telemetry-pipeline services to the namespace, you may need to exclude them too.

## Deploy to devrel-demo

Releasing is tag-driven and fully automated — pushing a release tag builds the images *and* deploys them to prod. There is no manual `pulumi up` step anymore.

```shell
git fetch --tags
./scripts/bump-release.sh patch   # or: minor / major
```

This reads the latest `*.*.*-release` tag, bumps it, then creates and pushes the new tag (add `--yes` to skip the confirmation prompts).

Pushing a tag matching `*.*.*-**` triggers the `[DevRel] Build and Publish` workflow (`.github/workflows/release-devrel.yml`):
[https://github.com/honeycombio/devrel-opentelemetry-demo/actions]()

- builds and pushes the changed component images tagged with the new version
- builds and pushes the custom collector image tagged `<version>-collector`
- runs `pulumi up` against stack `prod-aws` itself, with `container-tag=<version>` and `collector-container-tag=<version>-collector`

Wait for that workflow to go green — that's the whole release, no local pulumi commands needed.

To redeploy an already-built version (e.g. rollback) without rebuilding anything, run the `[DevRel] Deploy Specific Version` workflow (`deploy-with-version.yml`) manually from the Actions tab, passing the version and collector version tags.

Both workflows post a Honeycomb deploy marker (`/1/markers/__all__`, tagged
with the version and a link back to the Actions run) via
`scripts/create-deploy-marker.sh`, using the `HONEYCOMB_MARKERS_API_KEY`
repo secret (Settings → Secrets and variables → Actions). That key needs
`markers` permission on the environment `devrel-demo` ships to — it's a
separate secret from whatever key the production collector uses to ingest
telemetry.

### Troubleshooting

If skaffold gives you:

`Error: UPGRADE FAILED: another operation (install/upgrade/rollback) is in progress`

then you need to either rollback or delete the help release, by name. See all of the helm releases with:

```shell
helm list -Aa
```

for "All namespaces, also the ones that aren't fucking deployed yet"

Then see wtf it's doing, and if it's in the middle of an update you can

`helm rollback -n <you>-local <you>`

and if it's "pending install" you can

`helm delete -n <you>-local <you>`
