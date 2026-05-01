import os

from strands import Agent, tool
from strands.models.bedrock import BedrockModel

from tools import check_shipping, get_order, lookup_orders, refund_order

# Configure Bedrock model — use inference profile ARN if provided, otherwise default
_model_id = os.environ.get(
    "BEDROCK_MODEL_ID",
    os.environ.get("BEDROCK_HAIKU_PROFILE_ARN", ""),
)


def _make_model() -> BedrockModel | None:
    if not _model_id:
        return None
    # Cache the static prefix only (system prompt + tool definitions) — that
    # block is identical across every chat session and turn, so cache_read
    # dominates and cache_write happens once per ~5min cache TTL.
    # Avoid cache_config (which would also cache after the last user message,
    # causing a fresh cache_write every turn as the conversation grows).
    return BedrockModel(
        model_id=_model_id,
        cache_prompt="default",
        cache_tools="default",
    )


# --- Agent factory functions ---
# Created per-request so trace_attributes (conversation ID) can be set.


def _make_order_status_agent(trace_attributes: dict) -> Agent:
    attrs = {**trace_attributes, "gen_ai.agent.name": "order_status_agent"}
    kwargs: dict = {
        "name": "order_status_agent",
        "system_prompt": (
            "You look up customer orders and check their shipping status. "
            "Given a customer email, use lookup_orders to find their orders, "
            "then get_order for details, then check_shipping for tracking status. "
            "Return a structured summary of what you found."
        ),
        "tools": [lookup_orders, get_order, check_shipping],
        "callback_handler": None,
        "trace_attributes": attrs,
    }
    model = _make_model()
    if model:
        kwargs["model"] = model
    return Agent(**kwargs)


def _make_refund_agent(trace_attributes: dict) -> Agent:
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

SUPERVISOR_SYSTEM_PROMPT = """\
You are a friendly store assistant for Telescope Shop, an online telescope and astronomy store.

You help customers with their orders. You can:
- Look up order status and shipping information (use check_order_status)
- Process refunds (use process_refund)

When a customer contacts you:
1. If they mention an email, use it. If not, ask for their email address.
2. Route their request to the appropriate tool.
3. Compose a clear, helpful response based on the results.

If the customer asks about something you can't help with (product questions,
account issues, etc.), politely explain that you can only help with order
status and refunds.

Always be friendly and concise. Format your response as plain text.
"""


def create_supervisor(
    conversation_id: str,
    messages: list[dict] | None = None,
) -> Agent:
    """Create a supervisor agent with sub-agents, all sharing the conversation ID."""
    trace_attrs = {"gen_ai.conversation.id": conversation_id}

    # Create sub-agents per-request so they get the conversation ID
    order_agent = _make_order_status_agent(trace_attrs)
    refund_agent = _make_refund_agent(trace_attrs)

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
    kwargs: dict = {
        "name": "supervisor",
        "system_prompt": SUPERVISOR_SYSTEM_PROMPT,
        "tools": [check_order_status, process_refund],
        "callback_handler": None,
        "trace_attributes": supervisor_attrs,
    }
    model = _make_model()
    if model:
        kwargs["model"] = model
    if messages:
        kwargs["messages"] = messages
    return Agent(**kwargs)
