"""Fire-and-forget Kafka publisher for LLM eval jobs.

Pushes one JSON message to the `llm-evals` topic after each chat turn. The
`src/llm-evals/` consumer picks these up and runs judge scorers (Bias,
Hallucination, Relevance), emitting `gen_ai.evaluation.*` spans back onto the
source trace.

Payload shape matches `src/llm-evals/src/index.ts:29-42`.

No-op when `KAFKA_ADDR` is unset, and swallows all publish errors — eval
scoring must never block or break a chat response.
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
                client_id="storechat-llm-evals",
                value_serializer=lambda v: json.dumps(v).encode("utf-8"),
                acks=1,
                linger_ms=50,
                retries=1,
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
    conversation_id: Optional[str] = None,
    anchor_trace_id: Optional[int] = None,
    anchor_span_id: Optional[int] = None,
    requested_at_ns: Optional[int] = None,
) -> None:
    """Publish one eval job.

    `anchor_trace_id`/`anchor_span_id` identify the span the eval log should
    correlate to (e.g., the supervisor's invoke_agent span captured at end).
    `requested_at_ns` is the epoch-ns timestamp the eval consumer should use
    for the emitted log record so it lands on the trace timeline at the
    requesting span's end; the payload sends epoch-ms because epoch-ns
    overflows JS `Number.MAX_SAFE_INTEGER`. If any are unset, falls back to
    the currently-active span and `time.time_ns()`.
    """
    producer = _get_producer()
    if producer is None:
        return

    if anchor_trace_id is None or anchor_span_id is None:
        ctx = trace.get_current_span().get_span_context()
        if not ctx.is_valid:
            return
        anchor_trace_id = anchor_trace_id if anchor_trace_id is not None else ctx.trace_id
        anchor_span_id = anchor_span_id if anchor_span_id is not None else ctx.span_id
    if requested_at_ns is None:
        requested_at_ns = time.time_ns()

    payload = {
        "traceId": format(anchor_trace_id, "032x"),
        "spanId": format(anchor_span_id, "016x"),
        "requestedAtMs": requested_at_ns // 1_000_000,
        "sourceService": os.environ.get("OTEL_SERVICE_NAME", "store-chat"),
        "input": input_text,
        "output": output_text,
        "groundingContext": grounding_context,
        "agentName": agent_name,
        "responseModel": response_model or "unknown",
        "inputTokens": input_tokens,
        "outputTokens": output_tokens,
        "ttftMs": ttft_ms,
    }
    if conversation_id:
        payload["conversationId"] = conversation_id

    try:
        future = producer.send(_TOPIC, payload)
        future.add_callback(lambda md: LOG.info(
            "llm-evals delivered: topic=%s partition=%s offset=%s",
            md.topic, md.partition, md.offset))
        future.add_errback(lambda e: LOG.warning("llm-evals delivery failed: %s", e))
    except Exception as e:
        LOG.warning("llm-evals publish failed: %s", e)
