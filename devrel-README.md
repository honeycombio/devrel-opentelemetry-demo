# Setup for DevRel

Be a member of our Honeycomb Devrel Azure account.

## Install skaffold

```shell
curl -Lo skaffold https://storage.googleapis.com/skaffold/releases/latest/skaffold-linux-amd64 && \
sudo install skaffold /usr/local/bin/
```

or on macOS

```shell
brew install skaffold
```

## Install azure-cli

```shell
brew update && brew install azure-cli
```

### login to ACR

```shell
az acr login -n {repo name}
```
