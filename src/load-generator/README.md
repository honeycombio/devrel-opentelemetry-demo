# Load Generator

The load generator creates simulated traffic to the demo.

## Accessing the Load Generator

You can access the web interface to Locust at `http://localhost:8080/loadgen/`.

## Modifying the Load Generator

Please see the [Locust
documentation](https://docs.locust.io/en/2.16.0/writing-a-locustfile.html) to
learn more about modifying the locustfile.

## How to run

```bash
docker-compose up -d loadgen
```

## how to run with python

```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
locust -f locustfile.py
```


