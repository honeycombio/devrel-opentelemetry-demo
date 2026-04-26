import functools
import json
import os
import random
import threading

import grpc
import httpx
from opentelemetry import trace
from opentelemetry.trace import Status, StatusCode
from strands import tool

from conversation import evaluate_flag_percentage
from genproto import demo_pb2, demo_pb2_grpc


ACCOUNTING_ADDR = os.environ.get("ACCOUNTING_ADDR", "accounting:5060")
SHIPPING_ADDR = os.environ.get("SHIPPING_ADDR", "http://shipping:8080")
PRODUCT_CATALOG_ADDR = os.environ.get("PRODUCT_CATALOG_ADDR", "product-catalog:8080")

_channel_lock = threading.Lock()
_accounting_channel: grpc.Channel | None = None
_order_stub: demo_pb2_grpc.OrderServiceStub | None = None
_product_channel: grpc.Channel | None = None
_product_stub: demo_pb2_grpc.ProductCatalogServiceStub | None = None


def _mark_tool_error(exc: Exception, message: str) -> None:
    span = trace.get_current_span()
    span.set_status(Status(StatusCode.ERROR, message))
    error_type = type(exc).__name__
    if isinstance(exc, grpc.RpcError):
        code_name = getattr(exc.code(), "name", None) if callable(getattr(exc, "code", None)) else None
        if code_name:
            error_type = f"{error_type}.{code_name}"
    span.set_attribute("error.type", error_type)
    span.record_exception(exc)


def _get_stub() -> demo_pb2_grpc.OrderServiceStub:
    global _accounting_channel, _order_stub
    with _channel_lock:
        if _order_stub is None:
            _accounting_channel = grpc.insecure_channel(ACCOUNTING_ADDR)
            _order_stub = demo_pb2_grpc.OrderServiceStub(_accounting_channel)
        return _order_stub


def _invalidate_channel() -> None:
    global _accounting_channel, _order_stub
    with _channel_lock:
        if _accounting_channel is not None:
            try:
                _accounting_channel.close()
            except Exception:
                pass
        _accounting_channel = None
        _order_stub = None


def _is_retriable(exc: grpc.RpcError) -> bool:
    code = exc.code() if callable(getattr(exc, "code", None)) else None
    return code in (grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.UNKNOWN)


def _grpc_retry(error_message: str):
    def deco(fn):
        @functools.wraps(fn)
        def wrapper(*args, **kwargs):
            for attempt in (1, 2):
                try:
                    return fn(*args, **kwargs)
                except grpc.RpcError as e:
                    if attempt == 1 and _is_retriable(e):
                        _invalidate_channel()
                        continue
                    _mark_tool_error(e, error_message)
                    raise
        return wrapper
    return deco


def _order_detail_to_dict(d) -> dict:
    result = {
        "orderId": d.order_id,
        "email": d.email,
        "status": d.status,
        "createdAt": d.created_at,
        "transactionId": d.transaction_id,
        "shippingTrackingId": d.shipping_tracking_id,
    }
    if d.HasField("total_cost"):
        result["totalCost"] = {
            "currencyCode": d.total_cost.currency_code,
            "units": d.total_cost.units,
            "nanos": d.total_cost.nanos,
        }
    if d.HasField("shipping_address"):
        result["shippingAddress"] = {
            "streetAddress": d.shipping_address.street_address,
            "city": d.shipping_address.city,
            "state": d.shipping_address.state,
            "country": d.shipping_address.country,
            "zipCode": d.shipping_address.zip_code,
        }
    result["items"] = [
        {
            "item": {"productId": item.item.product_id, "quantity": item.item.quantity},
            "cost": {
                "currencyCode": item.cost.currency_code,
                "units": item.cost.units,
                "nanos": item.cost.nanos,
            },
        }
        for item in d.items
    ]
    return result


@tool
@_grpc_retry("order lookup failed")
def lookup_orders(email: str) -> str:
    """Find all orders for a customer by their email address.

    Args:
        email: The customer's email address.

    Returns:
        JSON array of orders, or an error message.
    """
    response = _get_stub().GetOrdersByEmail(
        demo_pb2.GetOrdersByEmailRequest(email=email),
        timeout=5,
    )
    orders = [_order_detail_to_dict(o) for o in response.orders]
    return json.dumps(orders, indent=2)


@tool
@_grpc_retry("order lookup failed")
def get_order(order_id: str) -> str:
    """Get full details for a specific order including items, shipping, and payment status.

    Args:
        order_id: The UUID order identifier.

    Returns:
        JSON object with order details, or an error message.
    """
    detail = _get_stub().GetOrder(
        demo_pb2.GetOrderRequest(order_id=order_id),
        timeout=5,
    )
    return json.dumps(_order_detail_to_dict(detail), indent=2)


@tool
def check_shipping(tracking_id: str) -> str:
    """Check the shipping status for a tracking ID.

    Args:
        tracking_id: The shipping tracking ID (UUID from the order's shippingTrackingId).

    Returns:
        JSON object with shipping status and estimated delivery date.
    """
    # Chaos injection: fail at the probability set by the storeChatShippingToolFailure
    # flag variant (off=0, 20%, 50%, 75%, 100%). Raises so the execute_tool span is
    # marked error=true and the supervisor's event loop gets to react.
    failure_rate = evaluate_flag_percentage("storeChatShippingToolFailure")
    if failure_rate > 0 and random.random() < failure_rate:
        raise ConnectionError("shipping service unreachable")

    try:
        resp = httpx.get(f"{SHIPPING_ADDR}/shipping-status/{tracking_id}", timeout=10)
        resp.raise_for_status()
        return json.dumps(resp.json(), indent=2)
    except httpx.HTTPError as e:
        _mark_tool_error(e, "shipping lookup failed")
        raise


@tool
@_grpc_retry("refund failed")
def refund_order(order_id: str, email: str) -> str:
    """Process a refund for an order. Requires the customer's email for verification.

    Args:
        order_id: The UUID order identifier to refund.
        email: The customer's email address (must match the order).

    Returns:
        JSON object with refund result (success/failure and transaction ID).
    """
    response = _get_stub().RefundOrder(
        demo_pb2.RefundOrderRequest(order_id=order_id, email=email),
        timeout=5,
    )
    return json.dumps({
        "success": response.success,
        "status": response.status,
        "refundTransactionId": response.refund_transaction_id,
    }, indent=2)
