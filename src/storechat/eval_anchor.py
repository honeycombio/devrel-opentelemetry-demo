"""Captures supervisor invoke_agent span identity + end time so eval logs
can be anchored to that span instead of the still-open FastAPI request span.

The supervisor's invoke_agent span closes inside supervisor(user_prompt). By
the time publish_eval runs in the request handler, only the request span is
still active. This processor catches the supervisor span on its way out and
parks its (trace_id, span_id, end_time_ns) keyed by trace_id, so publish_eval
can look it up and use those values.
"""

from collections import OrderedDict
from threading import Lock
from typing import Optional, Tuple

from opentelemetry.context import Context
from opentelemetry.sdk.trace import ReadableSpan, SpanProcessor

_MAX_ENTRIES = 1000
_anchors: "OrderedDict[int, Tuple[int, int, int]]" = OrderedDict()
_lock = Lock()


class SupervisorAgentAnchorProcessor(SpanProcessor):
    def on_start(self, span: "ReadableSpan", parent_context: Optional[Context] = None) -> None:
        return

    def on_end(self, span: ReadableSpan) -> None:
        attrs = span.attributes or {}
        if attrs.get("gen_ai.operation.name") != "invoke_agent":
            return
        if attrs.get("gen_ai.agent.name") != "supervisor":
            return
        ctx = span.get_span_context()
        if not ctx.is_valid:
            return
        with _lock:
            _anchors[ctx.trace_id] = (ctx.trace_id, ctx.span_id, span.end_time)
            while len(_anchors) > _MAX_ENTRIES:
                _anchors.popitem(last=False)

    def shutdown(self) -> None:
        return

    def force_flush(self, timeout_millis: int = 30000) -> bool:
        return True


def take_anchor(trace_id: int) -> Optional[Tuple[int, int, int]]:
    """Pop and return the anchor for trace_id, or None if absent."""
    with _lock:
        return _anchors.pop(trace_id, None)
