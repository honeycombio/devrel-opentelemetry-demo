# Recommendation Service

This service provides recommendations for other products based on the currently
selected product.

## Local Build

To build the protos, run from the root directory:

```sh
make docker-generate-protobuf
```

## Docker Build

From the root directory, run:

```sh
docker compose build recommendation
```

## Test that the program starts up locally

```
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
python recommendation_server.py
```
