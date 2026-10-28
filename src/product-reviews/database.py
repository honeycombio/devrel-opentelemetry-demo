#!/usr/bin/python

# Copyright The OpenTelemetry Authors
# SPDX-License-Identifier: Apache-2.0

# Python
import os
import simplejson as json

# Postgres
import psycopg2
from opentelemetry.instrumentation.psycopg2 import Psycopg2Instrumentor

def must_map_env(key: str):
    value = os.environ.get(key)
    if value is None:
        raise Exception(f'{key} environment variable must be set')
    return value

# SQLCommenter: append the current trace context to every query as a comment,
# e.g. /*traceparent='00-<trace_id>-<span_id>-01'*/. Postgres logs the comment
# with the statement, which lets the collector tie Postgres logs to this trace.
# `opentelemetry-instrument` has already instrumented psycopg2 without the
# commenter (there is no env var for it), so re-instrument with it enabled.
_psycopg2_instrumentor = Psycopg2Instrumentor()
if _psycopg2_instrumentor.is_instrumented_by_opentelemetry:
    _psycopg2_instrumentor.uninstrument()
_psycopg2_instrumentor.instrument(
    enable_commenter=True,
    # Keep the comment to the trace context; drop the driver metadata.
    commenter_options={
        "db_driver": False,
        "dbapi_level": False,
        "dbapi_threadsafety": False,
        "driver_paramstyle": False,
        "libpq_version": False,
    },
)

# Retrieve Postgres environment variables
db_connection_str = must_map_env('DB_CONNECTION_STRING')

def fetch_product_reviews(product_id):
    try:
        return json.dumps(fetch_product_reviews_from_db(product_id), use_decimal=True)
    except Exception as e:
        return json.dumps({"error": str(e)})

def fetch_product_reviews_from_db(request_product_id):

    connection = None

    try:
        with psycopg2.connect(db_connection_str) as connection:

            with connection.cursor() as cursor:
                # Define the SQL query
                query = "SELECT username, description, score FROM reviews.productreviews WHERE product_id= %s"

                # Execute the query
                cursor.execute(query, (request_product_id, ))

                # Fetch all the rows from the query result
                records = cursor.fetchall()
                return records

    except Exception as e:
        raise e
    finally:
        if connection is not None:
            try:
                connection.close()
            except Exception as e:
                pass

def fetch_avg_product_review_score_from_db(request_product_id):

    connection = None

    try:
        with psycopg2.connect(db_connection_str) as connection:

            with connection.cursor() as cursor:
                # Define the SQL query
                query = "SELECT AVG(score) FROM reviews.productreviews WHERE product_id= %s"

                # Execute the query
                cursor.execute(query, (request_product_id, ))

                # Fetch all the rows from the query result
                records = cursor.fetchall()

                # Extract the average score
                if records:
                    # records will be a list like [(average_score,)]
                    average_score = records[0][0]
                else:
                    # Handle the case where no records are returned (e.g., no reviews for the product)
                    average_score = None

                # return the score as a string rounded to 1 decimal place
                return f"{average_score:.1f}"

    except Exception as e:
        raise e
    finally:
        if connection is not None:
            try:
                connection.close()
            except Exception as e:
                pass
