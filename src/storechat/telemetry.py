"""Shapes Strands telemetry to the latest OTel GenAI semantic conventions.

Two adjustments the Strands SDK (1.45.0) does not offer natively:

1. Content on span attributes, not span events. The GenAI semconv
   (open-telemetry/semantic-conventions-genai, "Capturing instructions,
   inputs, and outputs") defines opt-in content capture as the span
   attributes gen_ai.system_instructions / gen_ai.input.messages /
   gen_ai.output.messages. Strands instead emits
   `gen_ai.client.inference.operation.details` span events, which both
   duplicates the payload and puts it where the spec doesn't look.
   `patch_strands_tracer` rewrites the tracer's event hook to set the
   attributes directly and emit no events. Content attributes are only
   applied to the span types whose spec tables include them (`chat`
   inference spans and internal `invoke_agent` spans) — tool spans get the
   dedicated gen_ai.tool.call.* attributes from `record_tool_call` instead.

2. gen_ai.response.finish_reasons (Recommended on inference spans) only
   exists inside Strands' serialized output-message JSON; the patch lifts
   it out onto the chat span.

The collector's transform/genai_span_events_to_attributes processor
finishes the reshaping for things only known span-wide (provider name,
canonical token attribute names, span name/kind).
"""

import functools
import inspect
import json
import logging

from opentelemetry import trace
from strands.telemetry.tracer import Tracer

logger = logging.getLogger(__name__)

# Span-attribute content capture is only defined for inference and
# in-process agent spans in the semconv tables.
_CONTENT_OPS = {"chat", "invoke_agent"}
_CONTENT_ATTRS = {
    "gen_ai.system_instructions",
    "gen_ai.input.messages",
    "gen_ai.output.messages",
}


def _span_operation(span) -> str | None:
    attributes = getattr(span, "attributes", None)
    if not attributes:
        return None
    return attributes.get("gen_ai.operation.name")


def _finish_reasons(output_messages_json: str) -> list[str]:
    messages = json.loads(output_messages_json)
    return [m["finish_reason"] for m in messages if isinstance(m, dict) and "finish_reason" in m]


def _add_event_as_attributes(self, span, event_name, event_attributes, to_span_attributes=False):
    """Replacement for Tracer._add_event: content goes to span attributes."""
    if span is None or not event_attributes:
        return

    operation = _span_operation(span)
    if operation not in _CONTENT_OPS:
        return

    attrs = {k: v for k, v in event_attributes.items() if k in _CONTENT_ATTRS}
    if not attrs:
        return

    output_messages = attrs.get("gen_ai.output.messages")
    if operation == "chat" and isinstance(output_messages, str):
        try:
            reasons = _finish_reasons(output_messages)
            if reasons:
                attrs["gen_ai.response.finish_reasons"] = reasons
        except (ValueError, TypeError, KeyError):
            logger.debug("could not extract finish_reasons from output messages")

    span.set_attributes(attrs)


def patch_strands_tracer() -> None:
    """Apply the event-to-attribute patch. Call once at startup, before any agent runs."""
    Tracer._add_event = _add_event_as_attributes


def record_tool_call(fn):
    """Record semconv execute_tool attributes on the current Strands tool span.

    Strands creates the `execute_tool {name}` span and runs the tool inside
    it, but only sets gen_ai.tool.name and gen_ai.tool.call.id. This adds the
    Recommended gen_ai.tool.type / gen_ai.tool.description and the Opt-In
    gen_ai.tool.call.arguments / gen_ai.tool.call.result. Place it *under*
    @tool so it wraps the raw function.
    """
    description = inspect.cleandoc(fn.__doc__ or "").split("\n\n")[0].replace("\n", " ").strip()
    signature = inspect.signature(fn)

    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        span = trace.get_current_span()
        on_tool_span = span.is_recording() and _span_operation(span) == "execute_tool"
        if on_tool_span:
            attrs = {"gen_ai.tool.type": "function"}
            if description:
                attrs["gen_ai.tool.description"] = description
            try:
                bound = signature.bind(*args, **kwargs)
                attrs["gen_ai.tool.call.arguments"] = json.dumps(dict(bound.arguments))
            except (TypeError, ValueError):
                pass
            span.set_attributes(attrs)

        result = fn(*args, **kwargs)

        if on_tool_span:
            span.set_attribute(
                "gen_ai.tool.call.result",
                result if isinstance(result, str) else json.dumps(result),
            )
        return result

    return wrapper
