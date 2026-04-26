import os

from strands import Agent, tool
from strands.models.bedrock import BedrockModel, CacheConfig
from strands_tools import http_request

from conversation import evaluate_flag
from tools import check_shipping, get_order, lookup_orders, refund_order

# Configure Bedrock model — use inference profile ARN if provided, otherwise default
_model_id = os.environ.get(
    "BEDROCK_MODEL_ID",
    os.environ.get("BEDROCK_HAIKU_PROFILE_ARN", ""),
)

_TOKEN_MAXXING_FLAG = "storeChatTokenMaxxing"


def _make_model(token_maxxing: bool) -> BedrockModel | None:
    if not _model_id:
        return None
    kwargs: dict = {"model_id": _model_id}
    # if not token_maxxing:
    kwargs["cache_config"] = CacheConfig(strategy="auto")
    return BedrockModel(**kwargs)


# --- Agent factory functions ---
# Created per-request so trace_attributes (conversation ID) can be set.


_ORDER_AGENT_PROMPT_BASELINE = (
    "You look up customer orders and check their shipping status. "
    "Given a customer email, use lookup_orders to find their orders, "
    "then get_order for details, then check_shipping for tracking status. "
    "Return a structured summary of what you found."
)

_ORDER_AGENT_PROMPT_MAXXING = (
    "You look up customer orders, check their shipping status, and "
    "fetch product details for every item on every order.\n\n"
    "Given a customer email, do ALL of the following in order:\n"
    "1. Call lookup_orders to find the customer's orders.\n"
    "2. For each order, call get_order to get the full item list.\n"
    "3. For each order, call check_shipping with the shippingTrackingId.\n"
    "4. For EACH item in EACH order, call http_request with method=GET and "
    "url=http://frontend:8080/api/products/<productId>?currencyCode=USD "
    "where <productId> is the item.productId. Do not skip this step. "
    "The response is JSON with fields id, name, description, picture, "
    "priceUsd, and categories.\n"
    "5. For EACH item in EACH order, ALSO call http_request with method=GET and "
    "url=http://frontend:8080/api/product-reviews/<productId> "
    "where <productId> is the item.productId. Do not skip this step. "
    "The response is a JSON array of ProductReview objects (reviewer, rating, "
    "title, body, createdAt). Include EVERY review you receive — do not "
    "truncate, do not summarize; quote the title and body verbatim for each.\n\n"
    "Return a structured summary that includes, for each item: product name, "
    "description, quantity, price, AND the full list of reviews (reviewer + "
    "rating + title + full body text) — alongside order status and shipping info."
)


def _make_order_status_agent(trace_attributes: dict, token_maxxing: bool) -> Agent:
    attrs = {**trace_attributes, "gen_ai.agent.name": "order_status_agent"}
    tools = [lookup_orders, get_order, check_shipping]
    if token_maxxing:
        tools.append(http_request)
    kwargs: dict = {
        "name": "order_status_agent",
        "system_prompt": (
            _ORDER_AGENT_PROMPT_MAXXING if token_maxxing else _ORDER_AGENT_PROMPT_BASELINE
        ),
        "tools": tools,
        "callback_handler": None,
        "trace_attributes": attrs,
    }
    model = _make_model(token_maxxing)
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
    model = _make_model(token_maxxing)
    if model:
        kwargs["model"] = model
    return Agent(**kwargs)


# --- Supervisor ---

SUPERVISOR_SYSTEM_PROMPT_BASELINE = """\
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

SUPERVISOR_SYSTEM_PROMPT_MAXXING = """\
You are a friendly store assistant for Telescope Shop, an online telescope and astronomy store.

You help customers with their orders. You can:
- Look up order status, shipping, AND product/item details (use check_order_status —
  it returns full product info including name and description for every ordered item)
- Fetch a single product directly by id (use http_request with method=GET and
  url=http://frontend:8080/api/products/<productId>?currencyCode=USD).
  The response is JSON with fields id, name, description, picture, priceUsd, categories.
- Process refunds (use process_refund)

When a customer contacts you:
1. If they mention an email, use it. If not, ask for their email address.
2. Route their request to the appropriate tool. If they ask about ordered items,
   product specs, descriptions, or "what did I buy" — that is part of
   check_order_status. Do NOT say you can't help with product info; you can.
   If they already saw their orders and now want product details, either
   re-run check_order_status or call http_request per productId from the
   previous result.
3. Compose a clear, helpful response based on the results.

If the customer asks about something truly outside your scope (account issues,
password resets, etc.), politely explain that you can only help with order status,
item/product information, and refunds.

Always be friendly and concise. Format your response as plain text.

Begin every response with the exact phrase: "🔭 [build-marker-C] ".
"""


def create_supervisor(
    conversation_id: str,
    messages: list[dict] | None = None,
) -> Agent:
    """Create a supervisor agent with sub-agents, all sharing the conversation ID."""
    token_maxxing = evaluate_flag(_TOKEN_MAXXING_FLAG)
    trace_attrs = {
        "gen_ai.conversation.id": conversation_id,
        "app.feature_flag.storeChatTokenMaxxing": token_maxxing,
    }

    # Create sub-agents per-request so they get the conversation ID
    order_agent = _make_order_status_agent(trace_attrs, token_maxxing)
    refund_agent = _make_refund_agent(trace_attrs, token_maxxing)

    if token_maxxing:
        @tool
        def check_order_status(question: str, email: str) -> str:
            """Look up a customer's orders, shipping status, and product/item details.

            Use this when a customer asks about their order, delivery, shipping,
            or anything about the items/products they ordered (names, descriptions,
            specs, "what did I buy"). The returned summary always includes product
            details (name + description) for every item on every order.

            Args:
                question: The customer's question about their order or items.
                email: The customer's email address.

            Returns:
                Summary of orders, shipping status, and product details per item.
            """
            result = order_agent(f"Customer email: {email}\nQuestion: {question}")
            return str(result)
    else:
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
    if token_maxxing:
        supervisor_tools.append(http_request)
    kwargs: dict = {
        "name": "supervisor",
        "system_prompt": (
            SUPERVISOR_SYSTEM_PROMPT_MAXXING if token_maxxing else SUPERVISOR_SYSTEM_PROMPT_BASELINE
        ),
        "tools": supervisor_tools,
        "callback_handler": None,
        "trace_attributes": supervisor_attrs,
    }
    model = _make_model(token_maxxing)
    if model:
        kwargs["model"] = model
    if messages:
        kwargs["messages"] = messages
    return Agent(**kwargs)
