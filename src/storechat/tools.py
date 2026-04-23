import json
import os
import random

import grpc
import httpx
from opentelemetry import trace
from opentelemetry.trace import Status, StatusCode
from strands import tool

from conversation import evaluate_flag_percentage
from genproto import demo_pb2, demo_pb2_grpc


ACCOUNTING_ADDR = os.environ.get("ACCOUNTING_ADDR", "accounting:5060")
SHIPPING_ADDR = os.environ.get("SHIPPING_ADDR", "http://shipping:8080")

_accounting_channel = grpc.insecure_channel(ACCOUNTING_ADDR)
_order_stub = demo_pb2_grpc.OrderServiceStub(_accounting_channel)


def _mark_tool_error(exc: Exception, message: str) -> None:
    span = trace.get_current_span()
    span.set_status(Status(StatusCode.ERROR, message))
    span.set_attribute("gen_ai.tool.status", "error")
    span.record_exception(exc)


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
def lookup_orders(email: str) -> str:
    """Find all orders for a customer by their email address.

    Args:
        email: The customer's email address.

    Returns:
        JSON array of orders, or an error message.
    """
    try:
        response = _order_stub.GetOrdersByEmail(
            demo_pb2.GetOrdersByEmailRequest(email=email),
            timeout=5,
        )
        orders = [_order_detail_to_dict(o) for o in response.orders]
        return json.dumps(orders, indent=2)
    except grpc.RpcError as e:
        _mark_tool_error(e, "order lookup failed")
        return json.dumps({
            "error": "order lookup failed",
            "code": e.code().name,
            "detail": e.details(),
        })


@tool
def get_order(order_id: str) -> str:
    """Get full details for a specific order including items, shipping, and payment status.

    Args:
        order_id: The UUID order identifier.

    Returns:
        JSON object with order details, or an error message.
    """
    try:
        detail = _order_stub.GetOrder(
            demo_pb2.GetOrderRequest(order_id=order_id),
            timeout=5,
        )
        return json.dumps(_order_detail_to_dict(detail), indent=2)
    except grpc.RpcError as e:
        _mark_tool_error(e, "order lookup failed")
        return json.dumps({
            "error": "order lookup failed",
            "code": e.code().name,
            "detail": e.details(),
        })


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
        return json.dumps({
            "error": "shipping lookup failed",
            "detail": str(e),
        })


@tool
def refund_order(order_id: str, email: str) -> str:
    """Process a refund for an order. Requires the customer's email for verification.

    Args:
        order_id: The UUID order identifier to refund.
        email: The customer's email address (must match the order).

    Returns:
        JSON object with refund result (success/failure and transaction ID).
    """
    try:
        response = _order_stub.RefundOrder(
            demo_pb2.RefundOrderRequest(order_id=order_id, email=email),
            timeout=5,
        )
        return json.dumps({
            "success": response.success,
            "status": response.status,
            "refundTransactionId": response.refund_transaction_id,
        }, indent=2)
    except grpc.RpcError as e:
        _mark_tool_error(e, "refund failed")
        return json.dumps({
            "error": "refund failed",
            "code": e.code().name,
            "detail": e.details(),
        })
