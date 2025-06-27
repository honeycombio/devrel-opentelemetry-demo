#!/usr/bin/python

# Copyright The OpenTelemetry Authors
# SPDX-License-Identifier: Apache-2.0

# Modified load generator to simulate a single customer generating errors

import json
import os
import random
import uuid
import logging

from locust import HttpUser, task, between

from opentelemetry import context, baggage
from opentelemetry._logs import set_logger_provider
from opentelemetry.exporter.otlp.proto.grpc._log_exporter import (
    OTLPLogExporter,
)
from opentelemetry.sdk._logs import LoggerProvider, LoggingHandler
from opentelemetry.sdk._logs.export import BatchLogRecordProcessor
from opentelemetry.sdk.resources import Resource

resource=Resource.create(
        {
            "service.name": "ecommerce-store-client"
        }
    )
logger_provider = LoggerProvider(resource=resource)
set_logger_provider(logger_provider)

exporter = OTLPLogExporter(insecure=True)
logger_provider.add_log_record_processor(BatchLogRecordProcessor(exporter))
handler = LoggingHandler(level=logging.INFO, logger_provider=logger_provider)

# Attach OTLP handler to root logger and create a specific logger for our use
logging.getLogger().addHandler(handler)
logging.getLogger().setLevel(logging.INFO)

# Create a specific logger with OTel handler for class methods
otel_logger = logging.getLogger('error_customer')
otel_logger.addHandler(handler)
otel_logger.setLevel(logging.INFO)

logging.info("Instrumentation complete")

# Valid products for successful requests
valid_products = [
    "0PUK6V6EV0",
    "1YMWWN1N4O",
    "2ZYFJ3GM2N",
    "66VCHSJNUP",
    "6E92ZMYYFZ",
    "9SIQT8TOJO",
    "L9ECAV7KIM",
    "LS4PSXUNUM",
    "OLJCESPC7Z",
    "HQTGWGPNH4",
]

# Invalid products to generate errors (look like real product IDs but don't exist)
invalid_products = [
    "9XYZ123ABC",
    "7DEF456GHI", 
    "5JKL789MNO",
    "3PQR012STU",
    "1VWX345YZA",
    "8BCD678EFG",
    "6HIJ901KLM",
    "4NOP234QRS",
    "2TUV567WXY",
    "0ZAB890CDE",
]

# Fixed customer ID for consistent error tracking
ERROR_CUSTOMER_ID = "cust642adf325"

people_file = open('people.json')
people = json.load(people_file)

# this doesn't happen
logging.warning("Time to generate some errors!", extra={"app.user.id": ERROR_CUSTOMER_ID})

class ErrorCustomer(HttpUser):
    host = "http://localhost:9191"
    wait_time = between(1, 5)
    
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.customer_id = ERROR_CUSTOMER_ID
        
    @task(2)
    def browse_invalid_product(self):
        """Browse invalid products to generate 404 errors"""
        invalid_product = random.choice(invalid_products)
        
        otel_logger.info(f"Attempting to browse invalid product: {invalid_product}", extra={"app.user.id": self.customer_id})
        otel_logger.error(f"Starting invalid product browse for customer {self.customer_id}", extra={"app.user.id": self.customer_id})
        otel_logger.error(f"Selected invalid product for testing: {invalid_product}", extra={"app.user.id": self.customer_id})

        with self.client.get(f"/api/products/{invalid_product}", catch_response=True) as response:
            otel_logger.error(f"API request sent to /api/products/{invalid_product}", extra={"app.user.id": self.customer_id})
            
            if response.status_code == 404:
                otel_logger.error(f"Product not found: {invalid_product} - Expected 404 error generated", extra={"app.user.id": self.customer_id})
                otel_logger.error(f"Successfully generated 404 error for customer {self.customer_id} with product {invalid_product}", extra={"app.user.id": self.customer_id})
                response.success()  # Mark as successful for load testing purposes
            elif response.status_code >= 400:
                otel_logger.error(f"Unexpected error browsing product {invalid_product}: HTTP {response.status_code} - {response.text}", extra={"app.user.id": self.customer_id})
                otel_logger.error(f"Unexpected HTTP error code {response.status_code} for customer {self.customer_id}", extra={"app.user.id": self.customer_id})
                response.success()
            else:
                otel_logger.warning(f"Expected error but got success for invalid product {invalid_product}: HTTP {response.status_code}", extra={"app.user.id": self.customer_id})
                otel_logger.error(f"Unexpected success response for invalid product - this indicates a system issue", extra={"app.user.id": self.customer_id})
                response.failure(f"Expected 404 but got {response.status_code}")
                
        otel_logger.error(f"Completed invalid product browse attempt for customer {self.customer_id}", extra={"app.user.id": self.customer_id})
                
    @task(3)
    def add_invalid_product_to_cart(self):
        """Try to add invalid products to cart"""
        invalid_product = random.choice(invalid_products)
        quantity = random.choice([1, 2, 3])
        
        otel_logger.error(f"Starting add invalid product to cart for customer {self.customer_id}", extra={"app.user.id": self.customer_id})
        otel_logger.error(f"Selected invalid product {invalid_product} with quantity {quantity}", extra={"app.user.id": self.customer_id})
        
        cart_item = {
            "item": {
                "productId": invalid_product,
                "quantity": quantity,
            },
            "userId": self.customer_id,
        }
        otel_logger.error(f"Constructed cart item payload: {cart_item}", extra={"app.user.id": self.customer_id})
        
        with self.client.post("/api/cart", json=cart_item, catch_response=True) as response:
            otel_logger.error(f"Posted to /api/cart with invalid product {invalid_product}", extra={"app.user.id": self.customer_id})
            
            # Expect this to fail, but mark as success for load testing
            if response.status_code >= 400:
                otel_logger.error(f"Cart add failed as expected: HTTP {response.status_code} for product {invalid_product}", extra={"app.user.id": self.customer_id})
                otel_logger.error(f"Error response body: {response.text}", extra={"app.user.id": self.customer_id})
                response.success()
            else:
                otel_logger.error(f"Unexpected success adding invalid product {invalid_product} to cart", extra={"app.user.id": self.customer_id})
            
        # Now try to get the cart after adding the item
        otel_logger.error(f"Attempting to retrieve cart for customer {self.customer_id}", extra={"app.user.id": self.customer_id})
        cart_response = self.client.get(f"/api/cart?sessionId={self.customer_id}&currencyCode=")
        
        otel_logger.error(f"Cart retrieval completed with status {cart_response.status_code}", extra={"app.user.id": self.customer_id})
        if cart_response.status_code >= 400:
            otel_logger.error(f"Cart retrieval failed: HTTP {cart_response.status_code} - {cart_response.text}", extra={"app.user.id": self.customer_id})
        else:
            otel_logger.error(f"Cart retrieved successfully, response length: {len(cart_response.text)} chars", extra={"app.user.id": self.customer_id})
            
        otel_logger.error(f"Completed add invalid product to cart attempt for customer {self.customer_id}", extra={"app.user.id": self.customer_id})
                
    @task(1)
    def browse_valid_product(self):
        """Occasionally browse valid products for contrast"""
        valid_product = random.choice(valid_products)
        
        otel_logger.error(f"Browsing valid product {valid_product} for contrast - customer {self.customer_id}", extra={"app.user.id": self.customer_id})
        
        response = self.client.get(f"/api/products/{valid_product}")
        
        otel_logger.error(f"Valid product browse completed with status {response.status_code}", extra={"app.user.id": self.customer_id})
        
    @task(2)
    def get_recommendations_for_invalid_product(self):
        """Get recommendations for invalid products"""
        invalid_product = random.choice(invalid_products)
        
        otel_logger.error(f"Starting recommendations request for invalid product - customer {self.customer_id}", extra={"app.user.id": self.customer_id})
        otel_logger.error(f"Requesting recommendations for invalid product: {invalid_product}", extra={"app.user.id": self.customer_id})
        
        params = {
            "productIds": [invalid_product],
        }
        otel_logger.error(f"Recommendation request params: {params}", extra={"app.user.id": self.customer_id})
        
        with self.client.get("/api/recommendations", params=params, catch_response=True) as response:
            otel_logger.error(f"Recommendations API called for invalid product {invalid_product}", extra={"app.user.id": self.customer_id})
            
            if response.status_code >= 400:
                otel_logger.error(f"Recommendations failed as expected: HTTP {response.status_code}", extra={"app.user.id": self.customer_id})
                otel_logger.error(f"Recommendations error response: {response.text}", extra={"app.user.id": self.customer_id})
                response.success()
            else:
                otel_logger.error(f"Unexpected success getting recommendations for invalid product {invalid_product}", extra={"app.user.id": self.customer_id})
                
        otel_logger.error(f"Completed recommendations request for customer {self.customer_id}", extra={"app.user.id": self.customer_id})
                
    @task(1)
    def checkout_with_invalid_items(self):
        """Try to checkout with invalid items in cart"""
        otel_logger.error(f"Starting checkout with invalid items flow - customer {self.customer_id}", extra={"app.user.id": self.customer_id})
        
        # First add some invalid items
        num_items = random.choice([1, 2])
        otel_logger.error(f"Adding {num_items} invalid items to cart before checkout", extra={"app.user.id": self.customer_id})
        
        for i in range(num_items):
            invalid_product = random.choice(invalid_products)
            
            otel_logger.error(f"Adding invalid item {i+1}/{num_items}: {invalid_product}", extra={"app.user.id": self.customer_id})
            
            cart_item = {
                "item": {
                    "productId": invalid_product,
                    "quantity": 1,
                },
                "userId": self.customer_id,
            }
            
            response = self.client.post("/api/cart", json=cart_item)
            otel_logger.error(f"Added invalid product {invalid_product} to cart - status: {response.status_code}", extra={"app.user.id": self.customer_id})
            
            # Try to get the cart after adding each item
            otel_logger.error(f"Retrieving cart after adding item {i+1}/{num_items}", extra={"app.user.id": self.customer_id})
            cart_response = self.client.get(f"/api/cart?sessionId={self.customer_id}&currencyCode=")
            otel_logger.error(f"Cart retrieval after item {i+1} - status: {cart_response.status_code}", extra={"app.user.id": self.customer_id})
                
        # Try to checkout
        checkout_person = random.choice(people)
        checkout_person["userId"] = self.customer_id
        
        otel_logger.error(f"Attempting checkout with invalid cart contents for customer {self.customer_id}", extra={"app.user.id": self.customer_id})
        otel_logger.error(f"Checkout person data: {checkout_person['email']}", extra={"app.user.id": self.customer_id})
        
        with self.client.post("/api/checkout", json=checkout_person, catch_response=True) as response:
            otel_logger.error(f"Checkout API called with invalid cart items", extra={"app.user.id": self.customer_id})
            
            if response.status_code >= 400:
                otel_logger.error(f"Checkout failed as expected: HTTP {response.status_code}", extra={"app.user.id": self.customer_id})
                otel_logger.error(f"Checkout error response: {response.text}", extra={"app.user.id": self.customer_id})
                response.success()
            else:
                otel_logger.error(f"Unexpected checkout success with invalid items - this indicates a system issue", extra={"app.user.id": self.customer_id})
                
        otel_logger.error(f"Completed checkout attempt for customer {self.customer_id}", extra={"app.user.id": self.customer_id})

    def on_start(self):
        otel_logger.error(f"Initializing error customer session for {self.customer_id}", extra={"app.user.id": self.customer_id})
        
        session_id = str(uuid.uuid4())
        
        ctx = baggage.set_baggage("session.id", session_id)
        ctx = baggage.set_baggage("synthetic_request", "true", context=ctx)
        ctx = baggage.set_baggage("customer.id", self.customer_id, context=ctx)
        ctx = baggage.set_baggage("customer.type", "error_generator", context=ctx)
        context.attach(ctx)
        
        otel_logger.error(f"Baggage context attached for error customer {self.customer_id}", extra={"app.user.id": self.customer_id})
        
        otel_logger.error(f"Starting homepage visit for error customer session", extra={"app.user.id": self.customer_id})
        
        # Start with homepage
        homepage_response = self.client.get("/")
        
        otel_logger.error(f"Homepage loaded with status {homepage_response.status_code} for customer {self.customer_id}", extra={"app.user.id": self.customer_id})
        
        otel_logger.error(f"Error customer {self.customer_id} session fully initialized and ready for error generation", extra={"app.user.id": self.customer_id})