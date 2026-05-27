#!/usr/bin/python

# Copyright The OpenTelemetry Authors
# SPDX-License-Identifier: Apache-2.0

import json
import os
import random
import time
import uuid
import logging

from locust import HttpUser, task, between
from locust_plugins.users.playwright import PlaywrightUser, pw, PageWithRetry, event

from opentelemetry import context, baggage, trace
from opentelemetry.context import Context
from opentelemetry.metrics import set_meter_provider
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.exporter.otlp.proto.grpc.metric_exporter import OTLPMetricExporter
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
from opentelemetry.instrumentation.jinja2 import Jinja2Instrumentor
from opentelemetry.instrumentation.requests import RequestsInstrumentor
from opentelemetry.instrumentation.system_metrics import SystemMetricsInstrumentor
from opentelemetry.instrumentation.urllib3 import URLLib3Instrumentor
from opentelemetry.instrumentation.logging import LoggingInstrumentor
from opentelemetry._logs import set_logger_provider
from opentelemetry.exporter.otlp.proto.grpc._log_exporter import OTLPLogExporter
from opentelemetry.sdk._logs import LoggerProvider, LoggingHandler
from opentelemetry.sdk._logs.export import BatchLogRecordProcessor
from opentelemetry.sdk.resources import Resource
from opentelemetry.propagate import set_global_textmap
from opentelemetry.baggage.propagation import W3CBaggagePropagator

from openfeature import api
from openfeature.contrib.provider.ofrep import OFREPProvider
from openfeature.contrib.hook.opentelemetry import TracingHook

from playwright.async_api import Route, Request

# Configure tracer provider first (needed for trace context in logs)
tracer_provider = TracerProvider()
trace.set_tracer_provider(tracer_provider)
tracer_provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(insecure=True)))

# Drop traceparent from outbound HTTP. Loadgen still emits its own spans, but
# downstream services see no incoming trace context and start fresh root
# traces — matching how real edge traffic looks. Baggage still propagates so
# synthetic_request=true survives.
set_global_textmap(W3CBaggagePropagator())

# Configure logger provider with the same resource
logger_provider = LoggerProvider()
set_logger_provider(logger_provider)

# Set up log exporter and processor
log_exporter = OTLPLogExporter(insecure=True)
logger_provider.add_log_record_processor(BatchLogRecordProcessor(log_exporter))

# Create logging handler that will include trace context
handler = LoggingHandler(level=logging.INFO, logger_provider=logger_provider)

# Configure root logger
root_logger = logging.getLogger()
root_logger.addHandler(handler)
root_logger.setLevel(logging.INFO)

# Configure metrics
metric_exporter = OTLPMetricExporter(insecure=True)
set_meter_provider(MeterProvider([PeriodicExportingMetricReader(metric_exporter)]))

# Instrument logging to automatically inject trace context
LoggingInstrumentor().instrument(set_logging_format=True)

# Instrumenting manually to avoid error with locust gevent monkey
Jinja2Instrumentor().instrument()
RequestsInstrumentor().instrument()
SystemMetricsInstrumentor().instrument()
URLLib3Instrumentor().instrument()

logging.info("Instrumentation complete - logs will now include trace context")

# Initialize Flagd provider
base_url = f"http://{os.environ.get('FLAGD_HOST', 'localhost')}:{os.environ.get('FLAGD_OFREP_PORT', 8016)}"
api.set_provider(OFREPProvider(base_url=base_url))
api.add_hooks([TracingHook()])

def get_flagd_value(FlagName):
    # Initialize OpenFeature
    client = api.get_client()
    return client.get_integer_value(FlagName, 0)

categories = [
    "binoculars",
    "telescopes",
    "accessories",
    "assembly",
    "travel",
    "books",
    None,
]

products = [
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

people_file = open('people.json')
people = json.load(people_file)


# A realistic-looking forwarded email thread a frustrated customer might paste
# into a chat: multi-level reply chain about a missing delivery, with the boilerplate
# confidential-disclosure footer repeated on every reply. Repeated 10x to mimic a
# deeply-escalated support thread (and to make the resulting token spike
# unmistakable). The store-chat /chat endpoint does not bound `question` size
# before sending it to the model, so a single turn containing this blob inflates
# `gen_ai.usage.input_tokens` for that one conversation by an order of magnitude
# versus a normal session.
PASTED_EMAIL_THREAD = """\
---------- Forwarded message ---------
From: Aurelia Customer Support <support@aurelia.honeydemo.io>
Date: Wed, May 13, 2026 at 4:32 PM
Subject: Re: Re: Re: Re: Order ORD-489201 — still no delivery
To: <me>

Hello,

Thank you for your patience. We have checked with our shipping partner and they
have confirmed that the package was scanned at the Memphis distribution center
on May 7. Unfortunately we have not received any further tracking updates since
then. We have opened an internal ticket (INC-2026-44811) with the carrier and a
member of our logistics team will follow up within 3-5 business days.

We understand the frustration that comes with a delayed shipment and we want to
assure you that we are doing everything we can on our end to locate the package.
If we are unable to confirm delivery within the next 7 business days we will
reship the order at no cost to you, or process a full refund — whichever you
prefer.

Kind regards,
Priya
Aurelia Customer Support — Tier 2

CONFIDENTIAL: This email and any attachments are confidential and intended
solely for the use of the individual or entity to whom they are addressed. If
you have received this email in error please notify the sender by reply email
and delete the message and any attachments from your system. Aurelia Holdings
Inc., its subsidiaries, and affiliates accept no liability for any damage
caused by any virus transmitted by this email. The views expressed in this
email are those of the sender and do not necessarily reflect those of Aurelia
Holdings Inc. Aurelia Holdings Inc. is registered in the State of Delaware,
registration number 7104228, registered office 1209 Orange Street, Wilmington
DE 19801. This communication may contain information that is proprietary,
privileged, or otherwise legally protected from disclosure. Any unauthorized
review, use, disclosure, dissemination, distribution, or copying of this
communication or its contents is strictly prohibited.

---------- Forwarded message ---------
From: <me>
Date: Mon, May 11, 2026 at 9:12 AM
Subject: Re: Re: Re: Order ORD-489201 — still no delivery
To: Aurelia Customer Support <support@aurelia.honeydemo.io>

Hi Priya,

It's now been a full week since the last update telling me the package was "in
transit". The tracking link you sent me hasn't moved since May 4. I've called
the shipping carrier directly and they told me they have no record of the
package leaving the Memphis facility. Can you please confirm with your
warehouse that the package actually shipped, and provide me with a fresh
tracking number if it didn't?

I bought this telescope as a birthday present for my partner. The birthday is
on May 22. If it's not going to arrive by then I'd rather just have a refund so
I can buy something locally — please let me know which option you can offer.

Thanks,
<me>

---------- Forwarded message ---------
From: Aurelia Customer Support <support@aurelia.honeydemo.io>
Date: Mon, May 4, 2026 at 2:48 PM
Subject: Re: Re: Order ORD-489201 — still no delivery
To: <me>

Hello,

Thank you for reaching out again. I can see from our records that your order
shipped on April 28 via our standard ground shipping partner, with an estimated
delivery window of May 2-6. The tracking number is 1Z999AA10123456784. Our
records show the package is currently in transit and should arrive within the
original estimated window.

If you do not receive the package by May 6, please reply to this email and we
will escalate to our shipping investigations team.

Kind regards,
Marcus
Aurelia Customer Support — Tier 1

CONFIDENTIAL: This email and any attachments are confidential and intended
solely for the use of the individual or entity to whom they are addressed. If
you have received this email in error please notify the sender by reply email
and delete the message and any attachments from your system. Aurelia Holdings
Inc., its subsidiaries, and affiliates accept no liability for any damage
caused by any virus transmitted by this email.

---------- Forwarded message ---------
From: <me>
Date: Mon, May 4, 2026 at 8:15 AM
Subject: Re: Order ORD-489201 — still no delivery
To: Aurelia Customer Support <support@aurelia.honeydemo.io>

Hello,

I placed order ORD-489201 on April 24 and have not received any shipping
confirmation since then. The order confirmation page said it should arrive
within 5-7 business days. It is now day 9 (excluding the weekend). Could
someone please look into where my order is?

Thanks,
<me>

---------- Forwarded message ---------
From: Aurelia Order Confirmation <noreply@aurelia.honeydemo.io>
Date: Sat, Apr 24, 2026 at 11:03 AM
Subject: Your Aurelia order ORD-489201 has been received
To: <me>

Thank you for your order!

Order number: ORD-489201
Order date: April 24, 2026
Estimated delivery: April 30 - May 6, 2026

Items:
  1 × Roof Prism Binoculars (8x42) ........................... $129.00
  1 × Lyra-Reflex 8-inch Dobsonian Telescope ................. $749.00
  1 × Plossl Eyepiece Set (4 piece) ..........................  $89.00

Subtotal: ................................................... $967.00
Shipping: ................................................... $  0.00 (free)
Tax: ........................................................ $ 58.02
Total: ...................................................... $1025.02

We'll send another email when your order ships. You can also check the status
of your order any time by logging into your account at aurelia.honeydemo.io.

CONFIDENTIAL: This email and any attachments are confidential and intended
solely for the use of the individual or entity to whom they are addressed. If
you have received this email in error please notify the sender by reply email
and delete the message and any attachments from your system. Aurelia Holdings
Inc., its subsidiaries, and affiliates accept no liability for any damage
caused by any virus transmitted by this email. The views expressed in this
email are those of the sender and do not necessarily reflect those of Aurelia
Holdings Inc. This message is sent from an unmonitored mailbox; replies will
not be read or answered.
""" * 8


def random_email() -> str:
    """Generate a fresh email per call so orders don't accumulate against
    a small fixed pool of customers. Without this, store-chat's
    lookup_orders returns an ever-growing list per email, and Strands'
    auto cache writes a larger prefix to Bedrock every turn."""
    return f"loadgen-{uuid.uuid4().hex[:12]}@aurelia.honeydemo.io"

# Per-user cooldown on the AI tasks (ask_product_ai_assistant and
# ask_store_chat). With Locust's wait_time=between(1,10) and the current
# weighted task mix, a weight-1 task is naturally selected once every
# ~3 minutes per user — so this cooldown only does real work above that
# threshold. 600s gives us roughly one AI invocation per user every ten
# minutes, which is what dominates Bedrock spend in this demo.
AI_TASK_MIN_INTERVAL_SECONDS = 600
PASTED_EMAIL_TASK_MIN_INTERVAL_SECONDS = 600  # ~10 min/user keeps this rare

# Agent (Bedrock-hitting) loadgen tasks are opt-in. Locals share one AWS
# account; without this guard every developer's namespace would hammer
# Bedrock concurrently, making cost and CloudWatch metrics unattributable.
# Set AGENT_LOAD_ENABLED=true in the deployed environment only.
agent_load_enabled = os.environ.get("AGENT_LOAD_ENABLED", "").lower() in ("true", "yes", "on", "1")


class WebsiteUser(HttpUser):
    wait_time = between(1, 10)

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.tracer = trace.get_tracer(__name__)
        self._last_ai_product_run = 0.0
        self._last_store_chat_run = 0.0
        self._last_pasted_email_run = 0.0
        self._last_refund_backup_run = 0.0

    @task(1)
    def index(self):
        with self.tracer.start_as_current_span("user_index", context=Context()):
            logging.info("User accessing index page")
            self.client.get("/")

    @task(10)
    def browse_product(self):
        product = random.choice(products)
        with self.tracer.start_as_current_span("user_browse_product", context=Context(), attributes={"product.id": product}):
            logging.info(f"User browsing product: {product}")
            self.client.get("/api/products/" + product)

    @task(3)
    def get_recommendations(self):
        product = random.choice(products)
        with self.tracer.start_as_current_span("user_get_recommendations", context=Context(), attributes={"product.id": product}):
            logging.info(f"User getting recommendations for product: {product}")
            params = {
                "productIds": [product],
            }
            self.client.get("/api/recommendations", params=params)

    @task(1)
    def get_product_reviews(self):
        product = random.choice(products)
        with self.tracer.start_as_current_span("user_get_product_reviews", context=Context(), attributes={"product.id": product}):
            logging.info(f"User getting product reviews for product: {product}")
            self.client.get("/api/product-reviews/" + product)

    @task(1)
    def ask_product_ai_assistant(self):
        # Rate-limit per user to ~1/min — this is the most expensive call
        # against product-reviews and we don't want it dominating traffic.
        if not agent_load_enabled:
            return
        now = time.monotonic()
        if now - self._last_ai_product_run < AI_TASK_MIN_INTERVAL_SECONDS:
            return
        self._last_ai_product_run = now
        product = random.choice(products)
        question = random.choice([
            "Can you summarize the product reviews?",
            "What magnification is best for stargazing with this product?",
            "Is this product suitable for beginners?",
            "How does this compare to other products in its category?",
            "What accessories do I need to get started with this?",
            "Is this good for observing planets or deep sky objects?",
            "What is the field of view like on this product?",
            "How portable is this for travel?",
            "What are the main pros and cons of this product?",
            "Would this work well for daytime nature observation?",
        ])
        with self.tracer.start_as_current_span("user_ask_product_ai_assistant", context=Context(), attributes={"product.id": product, "question": question}):
            logging.info(f"Asking the AI Assistant a question for: {product} {question}")
            self.client.post(f"/api/product-ask-ai-assistant/{product}", json={"question": question})

    # Small fixed pool of customer emails used by the refund-backup task. Reusing
    # the same emails (instead of a fresh UUID per session) means orders
    # accumulate against each one across loadgen runs, so lookup_orders ends up
    # returning a steadily-growing JSON blob. Used only when the
    # storechatRefundBackupOrders flag is on.
    BACKUP_REFUND_EMAILS = [
        "loyal-vip-1@aurelia.honeydemo.io",
        "loyal-vip-2@aurelia.honeydemo.io",
        "loyal-vip-3@aurelia.honeydemo.io",
    ]

    # Multi-turn scripts for store-chat. Each entry is a list of 2-4 user
    # messages that a real customer might send in one session. The agent
    # keeps conversation state keyed by sessionId, so follow-ups inherit
    # context from earlier turns.
    STORE_CHAT_CONVERSATIONS = [
        [
            "What's the status of my most recent order?",
            "When will it arrive?",
            "Thanks!",
        ],
        [
            "Has my package shipped yet?",
            "Can you give me the tracking number?",
        ],
        [
            "I need to return something.",
            "Yes, please refund my most recent order — it arrived damaged.",
            "When will the money be back on my card?",
        ],
        [
            "Can you look up my recent orders?",
            "Refund the telescope, it's the wrong model.",
        ],
        [
            "My order hasn't arrived yet and it's been a week.",
            "Can you check the shipping status?",
            "If it's lost, please refund it.",
        ],
        [
            "I bought something last week, what was it?",
            "How much did I pay for it?",
        ],
    ]

    def _place_order_for_chat(self, user: str, email: str):
        # Inline order flow so the store-chat session has something to
        # look up. Self-contained — no state kept on the user instance.
        item_count = random.choice([1, 2, 3])
        for _ in range(item_count):
            product = random.choice(products)
            quantity = random.choice([1, 2, 3])
            self.client.get("/api/products/" + product)
            self.client.post("/api/cart", json={
                "item": {"productId": product, "quantity": quantity},
                "userId": user,
            })
        checkout_person = {**random.choice(people), "userId": user, "email": email}
        self.client.post("/api/checkout", json=checkout_person)

    @task(1)
    def ask_store_chat(self):
        # store-chat is the post-purchase customer-service agent (orders,
        # refunds, shipping status). Rate-limit per user to ~1/min so AI
        # spend stays bounded; pick a randomized turn count so some
        # sessions are quick and some are longer.
        if not agent_load_enabled:
            return
        now = time.monotonic()
        if now - self._last_store_chat_run < AI_TASK_MIN_INTERVAL_SECONDS:
            return
        self._last_store_chat_run = now
        email = random_email()
        user = str(uuid.uuid1())
        session_id = str(uuid.uuid4())
        with self.tracer.start_as_current_span(
            "user_store_chat_place_order",
            context=Context(),
            attributes={"user.id": user, "email": email},
        ):
            logging.info(f"Placing order for store-chat session as {email}")
            self._place_order_for_chat(user=user, email=email)
        full_conversation = random.choice(self.STORE_CHAT_CONVERSATIONS)
        n_turns = random.randint(1, len(full_conversation))
        conversation = full_conversation[:n_turns]
        with self.tracer.start_as_current_span(
            "user_ask_store_chat",
            context=Context(),
            attributes={
                "session.id": session_id,
                "email": email,
                "conversation.length": len(conversation),
            },
        ):
            logging.info(f"Starting store-chat session {session_id} as {email} ({len(conversation)} turns)")
            for turn_index, question in enumerate(conversation):
                with self.tracer.start_as_current_span(
                    "user_store_chat_turn",
                    attributes={
                        "session.id": session_id,
                        "turn.index": turn_index,
                        "question": question,
                    },
                ):
                    logging.info(f"[session {session_id}] turn {turn_index}: {question}")
                    self.client.post(
                        "/store-chat/chat",
                        json={"question": question, "sessionId": session_id, "email": email},
                    )

    @task(1)
    def ask_store_chat_pasted_email(self):
        # Very rare: simulate a frustrated customer who pastes their entire
        # forwarded email thread with support into a single chat turn. /chat
        # doesn't bound the user `question` size before sending it to the model,
        # so this one conversation balloons LLM input_tokens vs. a normal
        # session — a clean per-conversation token spike to investigate.
        if not agent_load_enabled:
            return
        now = time.monotonic()
        if now - self._last_pasted_email_run < PASTED_EMAIL_TASK_MIN_INTERVAL_SECONDS:
            return
        self._last_pasted_email_run = now
        email = random_email()
        user = str(uuid.uuid1())
        session_id = str(uuid.uuid4())
        with self.tracer.start_as_current_span(
            "user_store_chat_place_order",
            context=Context(),
            attributes={"user.id": user, "email": email},
        ):
            logging.info(f"Placing order for pasted-email store-chat session as {email}")
            self._place_order_for_chat(user=user, email=email)
        question = (
            "Hi — my telescope order is severely delayed and your support has "
            "been bouncing me between agents for two weeks. I'm pasting the "
            "entire email thread below so the next person doesn't have to make "
            "me re-explain it. Please tell me what is actually going on with "
            "my order and whether I should expect it before May 22.\n\n"
            f"{PASTED_EMAIL_THREAD}"
        )
        with self.tracer.start_as_current_span(
            "user_ask_store_chat",
            context=Context(),
            attributes={
                "session.id": session_id,
                "email": email,
                "conversation.length": 1,
                "scenario": "pasted_email_thread",
            },
        ):
            logging.info(f"Starting pasted-email store-chat session {session_id} as {email}")
            with self.tracer.start_as_current_span(
                "user_store_chat_turn",
                attributes={
                    "session.id": session_id,
                    "turn.index": 0,
                    "question.length": len(question),
                },
            ):
                self.client.post(
                    "/store-chat/chat",
                    json={"question": question, "sessionId": session_id, "email": email},
                )

    @task(1)
    def ask_store_chat_refund_backup(self):
        # Flag-gated: when storechatRefundBackupOrders is on, route refund
        # traffic against a tiny fixed pool of emails so orders pile up against
        # each one. lookup_orders has no pagination, so the JSON returned to the
        # refund agent grows over time and the per-conversation LLM input_tokens
        # climb with it.
        if not agent_load_enabled:
            return
        if get_flagd_value("storechatRefundBackupOrders") <= 0:
            return
        now = time.monotonic()
        if now - self._last_refund_backup_run < AI_TASK_MIN_INTERVAL_SECONDS:
            return
        self._last_refund_backup_run = now
        email = random.choice(self.BACKUP_REFUND_EMAILS)
        user = str(uuid.uuid1())
        session_id = str(uuid.uuid4())
        with self.tracer.start_as_current_span(
            "user_store_chat_place_order",
            context=Context(),
            attributes={"user.id": user, "email": email, "scenario": "refund_backup"},
        ):
            logging.info(f"Placing order for refund-backup store-chat session as {email}")
            self._place_order_for_chat(user=user, email=email)
        conversation = [
            "Can you pull up my recent orders? I think I need to return one.",
            "Yes please refund my most recent order — it arrived damaged.",
            "Actually one of the earlier ones was the wrong model too, can you refund that one as well?",
        ]
        with self.tracer.start_as_current_span(
            "user_ask_store_chat",
            context=Context(),
            attributes={
                "session.id": session_id,
                "email": email,
                "conversation.length": len(conversation),
                "scenario": "refund_backup",
            },
        ):
            logging.info(f"Starting refund-backup store-chat session {session_id} as {email} ({len(conversation)} turns)")
            for turn_index, question in enumerate(conversation):
                with self.tracer.start_as_current_span(
                    "user_store_chat_turn",
                    attributes={
                        "session.id": session_id,
                        "turn.index": turn_index,
                        "question": question,
                    },
                ):
                    logging.info(f"[session {session_id}] turn {turn_index}: {question}")
                    self.client.post(
                        "/store-chat/chat",
                        json={"question": question, "sessionId": session_id, "email": email},
                    )

    @task(3)
    def get_ads(self):
        category = random.choice(categories)
        with self.tracer.start_as_current_span("user_get_ads", context=Context(), attributes={"category": str(category)}):
            logging.info(f"User getting ads for category: {category}")
            params = {
                "contextKeys": [category],
            }
            self.client.get("/api/data/", params=params)

    @task(3)
    def view_cart(self):
        with self.tracer.start_as_current_span("user_view_cart", context=Context()):
            logging.info("User viewing cart")
            self.client.get("/api/cart")

    @task(2)
    def add_to_cart(self, user=""):
        iterations = random.choice([1, 2, 3, 4, 5])
        for _ in range(iterations):
            if user == "":
                user = str(uuid.uuid1())
            product = random.choice(products)
            quantity = random.choice([1, 2, 3, 4, 5, 10])
            with self.tracer.start_as_current_span("user_add_to_cart", context=Context(), attributes={"user.id": user, "product.id": product, "quantity": quantity}):
                logging.info(f"User {user} adding {quantity} of product {product} to cart")
                self.client.get("/api/products/" + product)
                cart_item = {
                    "item": {
                        "productId": product,
                        "quantity": quantity,
                    },
                    "userId": user,
                }
                self.client.post("/api/cart", json=cart_item)

    @task(1)
    def checkout(self):
        user = str(uuid.uuid1())
        with self.tracer.start_as_current_span("user_checkout_single", context=Context(), attributes={"user.id": user}):
            self.add_to_cart(user=user)
            checkout_person = {**random.choice(people), "userId": user, "email": random_email()}
            self.client.post("/api/checkout", json=checkout_person)
            logging.info(f"Checkout completed for user {user}")

    @task(1)
    def checkout_multi(self):
        user = str(uuid.uuid1())
        item_count = random.choice([2, 3, 4])
        with self.tracer.start_as_current_span("user_checkout_multi", context=Context(),
                                            attributes={"user.id": user, "item.count": item_count}):
            for i in range(item_count):
                self.add_to_cart(user=user)
            checkout_person = {**random.choice(people), "userId": user, "email": random_email()}
            self.client.post("/api/checkout", json=checkout_person)
            logging.info(f"Multi-item checkout completed for user {user}")

    @task(5)
    def flood_home(self):
        flood_count = get_flagd_value("loadGeneratorFloodHomepage")
        if flood_count > 0:
            with self.tracer.start_as_current_span("user_flood_home",  context=Context(), attributes={"flood.count": flood_count}):
                logging.info(f"User flooding homepage {flood_count} times")
                for _ in range(0, flood_count):
                    self.client.get("/")

    def on_start(self):
        with self.tracer.start_as_current_span("user_session_start", context=Context()):
            session_id = str(uuid.uuid4())
            logging.info(f"Starting user session: {session_id}")
            ctx = baggage.set_baggage("session.id", session_id)
            ctx = baggage.set_baggage("synthetic_request", "true", context=ctx)
            context.attach(ctx)
            self.index()


browser_traffic_enabled = os.environ.get("LOCUST_BROWSER_TRAFFIC_ENABLED", "").lower() in ("true", "yes", "on")

if browser_traffic_enabled:
    class WebsiteBrowserUser(PlaywrightUser):
        headless = True  # to use a headless browser, without a GUI

        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self.tracer = trace.get_tracer(__name__)

        @task
        @pw
        async def open_cart_page_and_change_currency(self, page: PageWithRetry):
            with self.tracer.start_as_current_span("browser_change_currency", context=Context()):
                try:
                    page.on("console", lambda msg: print(msg.text))
                    await page.route('**/*', add_baggage_header)
                    await page.goto("/cart", wait_until="domcontentloaded")
                    await page.select_option('[name="currency_code"]', 'CHF')
                    await page.wait_for_timeout(2000)  # giving the browser time to export the traces
                    logging.info("Currency changed to CHF")
                except Exception as e:
                    logging.error(f"Error in change currency task: {str(e)}")

        @task
        @pw
        async def add_product_to_cart(self, page: PageWithRetry):
            with self.tracer.start_as_current_span("browser_add_to_cart", context=Context()):
                try:
                    page.on("console", lambda msg: print(msg.text))
                    await page.route('**/*', add_baggage_header)
                    await page.goto("/", wait_until="domcontentloaded")
                    await page.click('p:has-text("Roof Binoculars")')
                    await page.wait_for_load_state("domcontentloaded")
                    await page.click('button:has-text("Add To Cart")')
                    await page.wait_for_load_state("domcontentloaded")
                    await page.wait_for_timeout(2000)  # giving the browser time to export the traces
                    logging.info("Product added to cart successfully")
                except Exception as e:
                    logging.error(f"Error in add to cart task: {str(e)}")

async def add_baggage_header(route: Route, request: Request):
    existing_baggage = request.headers.get('baggage', '')
    headers = {
        **request.headers,
        'baggage': ', '.join(filter(None, (existing_baggage, 'synthetic_request=true')))
    }
    await route.continue_(headers=headers)
