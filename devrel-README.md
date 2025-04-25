# Setup for DevRel

Be a member of our Honeycomb Devrel Azure account.

There is another repo, devrel-opentelemetry-infra, that sets up the AKS cluster.
It also creates a container registry (ACR) and links the two together, so that the cluster can pull from the image repositories.
However, when we deploy things ourselves using skaffold, we're pushing them to ACR.

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

## Deploy to devrel-demo

What is the next release number?

```shell
git fetch -a
git tag --list
```

(replace 1.0.7 with something later)

```shell
git tag 1.0.7-release
git push origin 1.0.7-release
```

Wait for it to build <- this is forever
Visit [https://github.com/honeycombio/devrel-opentelemetry-demo/actions]() to wait for it

Edit `./deploy/config-files/demo/values.yaml` to have the new version

```shell
cd deploy

pulumi stack select honeycomb-devrel/prod # once

pulumi config refresh

# then maybe you can skip these?
pulumi config set devrel-opentelemetry-demo:ingressClassName <valu???> # once
pulumi config set devrel-opentelemetry-demo:honeycombApiKeyDogfood <value> # once
pulumi config set devrel-opentelemetry-demo:honeycombApiKey <value> # once

pulumi up
```

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
