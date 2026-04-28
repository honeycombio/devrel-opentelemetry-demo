import os
import random

from strands import Agent, tool
from strands.models.bedrock import BedrockModel, CacheConfig

from conversation import evaluate_flag_percentage
from tools import (
    check_shipping,
    get_order,
    get_product_details,
    lookup_orders,
    refund_order,
)

# Configure Bedrock model — use inference profile ARN if provided, otherwise default
_model_id = os.environ.get(
    "BEDROCK_MODEL_ID",
    os.environ.get("BEDROCK_HAIKU_PROFILE_ARN", ""),
)

_TOKEN_MAXXING_FLAG = "storeChatTokenMaxxing"


def _make_model() -> BedrockModel | None:
    if not _model_id:
        return None
    kwargs: dict = {"model_id": _model_id}
    kwargs["cache_config"] = CacheConfig(strategy="auto")
    return BedrockModel(**kwargs)


# --- Agent factory functions ---
# Created per-request so trace_attributes (conversation ID) can be set.


_ORDER_AGENT_PROMPT_BASELINE = (
    "You look up customer orders and check their shipping status. "
    "Given a customer email, use lookup_orders to find their orders, "
    "then get_order for details, then get_product_details for each order item's product details, "
    "then check_shipping for tracking status. "
    "Return a structured summary of what you found. "
    "When get_product_details returns a `reviews` array, include reviews verbatim "
    "(username, score, description) only when the customer asked about reviews — "
    "otherwise omit them from the summary."
)

_ORDER_AGENT_REVIEW_DIRECTIVE_MAXX = (
    " Always call get_product_details with include_reviews=True so reviews are "
    "fetched for every order item, regardless of whether the customer asked about reviews."
)

_ORDER_AGENT_REVIEW_DIRECTIVE_NORMAL = (
    " Call get_product_details with include_reviews=True only when the customer "
    "asks about reviews or product quality; otherwise pass include_reviews=False "
    "to skip the reviews fetch."
)


def _make_order_status_agent(trace_attributes: dict, token_maxxing: bool) -> Agent:
    attrs = {**trace_attributes, "gen_ai.agent.name": "order_status_agent"}
    tools = [lookup_orders, get_order, check_shipping, get_product_details]
    review_directive = (
        _ORDER_AGENT_REVIEW_DIRECTIVE_MAXX if token_maxxing
        else _ORDER_AGENT_REVIEW_DIRECTIVE_NORMAL
    )
    kwargs: dict = {
        "name": "order_status_agent",
        "system_prompt": _ORDER_AGENT_PROMPT_BASELINE + review_directive,
        "tools": tools,
        "callback_handler": None,
        "trace_attributes": attrs,
    }
    model = _make_model()
    if model:
        kwargs["model"] = model
    return Agent(**kwargs)


def _make_refund_agent(trace_attributes: dict, token_maxxing: bool) -> Agent:
    attrs = {**trace_attributes, "gen_ai.agent.name": "refund_agent"}
    kwargs: dict = {
        "name": "refund_agent",
        "system_prompt": (
            "You process refunds for customer orders. "
            "Given a customer email, use lookup_orders to find their order, "
            "then get_order to confirm details and status, "
            "then refund_order to process the refund. "
            "Report success or failure clearly including any error messages."
        ),
        "tools": [lookup_orders, get_order, refund_order],
        "callback_handler": None,
        "trace_attributes": attrs,
    }
    model = _make_model()
    if model:
        kwargs["model"] = model
    return Agent(**kwargs)


# --- Supervisor ---

SUPERVISOR_SYSTEM_PROMPT_BASELINE = """\
You are a friendly store assistant for Telescope Shop, an online telescope and astronomy store.

You help customers with their orders. You can:
- Look up order status and shipping information (use check_order_status). The
  result also includes full product details and customer reviews for each
  ordered item; include the review details in your reply only when the
  customer asks about reviews, otherwise omit them.
- Process refunds (use process_refund)

When a customer contacts you:
1. If they mention an email, use it. If not, ask for their email address.
2. Route their request to the appropriate tool.
3. Compose a clear, helpful response based on the results.

If the customer asks about something you can't help with (account issues,
password resets, etc.), politely explain that you can help with order
status, the products and reviews on their orders, and refunds.

Always be friendly and concise. Format your response as plain text.
"""

# SUPERVISOR_SYSTEM_PROMPT_MAXXING = """\
# You are a friendly store assistant for Telescope Shop, an online telescope and astronomy store.
#
# You help customers with their orders. You can:
# - Look up order status and shipping information (use check_order_status). For
#   order-status questions, also fetch product information for the items on the
#   order so the response describes what was ordered.
# - Process refunds (use process_refund)
#
# When a customer contacts you:
# 1. If they mention an email, use it. If not, ask for their email address.
# 2. Route their request to the appropriate tool.
# 3. Compose a clear, helpful response based on the results.
#
# If the customer asks about something you can't help with (account issues,
# password resets, etc.), politely explain that you can only help with order
# status and refunds.
#
# Always be friendly and concise. Format your response as plain text.
# """


def create_supervisor(
    conversation_id: str,
    messages: list[dict] | None = None,
) -> Agent:
    """Create a supervisor agent with sub-agents, all sharing the conversation ID."""
    maxxing_rate = evaluate_flag_percentage(_TOKEN_MAXXING_FLAG)
    token_maxxing = maxxing_rate > 0 and random.random() < maxxing_rate
    trace_attrs = {
        "gen_ai.conversation.id": conversation_id,
        "app.feature_flag.storeChatTokenMaxxing": token_maxxing,
    }

    # Create sub-agents per-request so they get the conversation ID
    order_agent = _make_order_status_agent(trace_attrs, token_maxxing)
    refund_agent = _make_refund_agent(trace_attrs, token_maxxing)

    @tool
    def check_order_status(question: str, email: str) -> str:
        """Look up a customer's orders and check shipping status.

        Use this when a customer asks about their order, delivery, or shipping.

        Args:
            question: The customer's question about their order.
            email: The customer's email address.

        Returns:
            Summary of order details and shipping status.
        """
        result = order_agent(f"Customer email: {email}\nQuestion: {question}")
        return str(result)

    @tool
    def process_refund(question: str, email: str) -> str:
        """Process a refund for a customer's order.

        Use this when a customer wants to return an item or get their money back.

        Args:
            question: The customer's refund request with any context.
            email: The customer's email address.

        Returns:
            Refund result including success/failure and transaction details.
        """
        result = refund_agent(f"Customer email: {email}\nRequest: {question}")
        return str(result)

    supervisor_attrs = {**trace_attrs, "gen_ai.agent.name": "supervisor"}
    supervisor_tools = [check_order_status, process_refund]
    kwargs: dict = {
        "name": "supervisor",
        "system_prompt": SUPERVISOR_SYSTEM_PROMPT_BASELINE,
        "tools": supervisor_tools,
        "callback_handler": None,
        "trace_attributes": supervisor_attrs,
    }
    model = _make_model()
    if model:
        kwargs["model"] = model
    if messages:
        kwargs["messages"] = messages
    return Agent(**kwargs)
