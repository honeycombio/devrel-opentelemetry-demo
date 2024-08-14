# Setup for DevRel

Be a member of our Honeycomb Devrel Azure account.

There is another repo, devrel-opentelemetry-infra, that sets up the AKS cluster.
It also creates a container registry (ACR) and links the two together, so that the cluster can pull from the image repositories.
However, when we deploy things ourselves using skaffold, we're pushing them to ACR.

The OpenTelemetry collector is deployed by this repo. For application telemetry, it uses a service instead of Martin's favorite nodeIP, because we want multiples in the cluster sending to different Honeycomb environments. This is doing something weird, because we are devrel and we do weird things.

## The public one

When we do CI, in github actions, that pushes release images to GHCR instead. (that was easier, they can be public we don't care)

For now,
We can deploy those with ./deploy, which is a pulumi thinger for deploying this demo from GHCR to AKS.
Some one else could modify that and deploy to their cluster, since the images are public.

Currently, this is available at www.demo.onlyspans.com (we're working on a honeydemo.io domain).
This is the public one that we will keep and up and usable. That pushes Honeycomb data to the devrel-data team.

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

### log in to pulumi

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
./scripts/acr-login.sh
```

#TODO create

### run skaffold

where acrName is the name of the azure container registry, TODO make that easy

and cartservice is a comma-separated list of services to build locally.

and yourkey is an ingest key; you can use devrel-demo/development env if you want.

```shell
export HONEYCOMB_API_KEY=yourkey
skaffold run -d acrName.azurecr.io -b cartservice
```

It makes a whole yourname-local namespace with all the stuff in it.

### shut down your iterative environment

```shell
skaffold delete
```
