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

## The error script

For local use, there's also an `error_customer.py`
which you can run with

```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
locust -f error_customer.py
```

and then visit http://localhost:8089
and then you can start a load test of one user that only likes invalid products.
This can generate some error messages, see.

Change the URL in the `host` parameter in the code to swap between your installation / production.

It logs excessively to a local collector.
