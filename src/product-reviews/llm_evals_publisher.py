"""Fire-and-forget Kafka publisher for LLM eval jobs.

Pushes one JSON message to the `llm-evals` topic after each assistant turn.
The `src/llm-evals/` consumer picks these up and runs judge scorers
(Bias, Hallucination, Relevance), emitting `gen_ai.evaluation.*` spans back
onto the source trace.

Payload shape matches `src/llm-evals/src/index.ts:29-42`.

No-op when `KAFKA_ADDR` is unset, and swallows all publish errors — eval
scoring must never block or break a user response.
"""

import json
import logging
import os
import threading
import time
from typing import Optional

from opentelemetry import trace

LOG = logging.getLogger(__name__)

_TOPIC = "llm-evals"
_producer = None
_producer_lock = threading.Lock()
_producer_init_failed = False


def _get_producer():
    global _producer, _producer_init_failed
    if _producer is not None or _producer_init_failed:
        return _producer
    addr = os.environ.get("KAFKA_ADDR")
    if not addr:
        _producer_init_failed = True
        return None
    with _producer_lock:
        if _producer is not None or _producer_init_failed:
            return _producer
        try:
            from kafka import KafkaProducer
            _producer = KafkaProducer(
                bootstrap_servers=[addr],
                client_id="product-reviews-llm-evals",
                value_serializer=lambda v: json.dumps(v).encode("utf-8"),
                acks=0,
                linger_ms=50,
                retries=0,
            )
            LOG.info("llm-evals producer connected to %s", addr)
        except Exception as e:
            LOG.warning("llm-evals producer init failed (%s) — evals disabled", e)
            _producer_init_failed = True
            _producer = None
    return _producer


def publish_eval(
    input_text: str,
    output_text: str,
    agent_name: str,
    grounding_context: str = "",
    response_model: Optional[str] = None,
    input_tokens: int = 0,
    output_tokens: int = 0,
    ttft_ms: int = 0,
) -> None:
    """Publish one eval job. Uses the current span's trace/span IDs as the
    anchor the eval consumer writes its scorer spans back onto."""
    producer = _get_producer()
    if producer is None:
        return

    ctx = trace.get_current_span().get_span_context()
    if not ctx.is_valid:
        return

    payload = {
        "traceId": format(ctx.trace_id, "032x"),
        "spanId": format(ctx.span_id, "016x"),
        "requestedAtMs": time.time_ns() // 1_000_000,
        "sourceService": os.environ.get("OTEL_SERVICE_NAME", "product-reviews"),
        "input": input_text,
        "output": output_text,
        "groundingContext": grounding_context,
        "agentName": agent_name,
        "responseModel": response_model or "unknown",
        "inputTokens": input_tokens,
        "outputTokens": output_tokens,
        "ttftMs": ttft_ms,
    }

    try:
        producer.send(_TOPIC, payload)
    except Exception as e:
        LOG.warning("llm-evals publish failed: %s", e)
