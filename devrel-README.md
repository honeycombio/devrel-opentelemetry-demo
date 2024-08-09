# Setup for DevRel

## Install skaffold

```shell
curl -Lo skaffold https://storage.googleapis.com/skaffold/releases/latest/skaffold-linux-amd64 && \
sudo install skaffold /usr/local/bin/
```

### login to ACR

```shell
az acr login -n {repo name}
```
