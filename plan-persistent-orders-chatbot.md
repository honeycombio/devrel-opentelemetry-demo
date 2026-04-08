# Plan: Persistent Orders, Order APIs, Chatbot Order Agent, and Shipping Status

## Context

The OpenTelemetry demo app has **transient orders** (the accounting service persists them to PostgreSQL but only stores `order_id` - no user association, no status, no timestamps). We need to:

1. Enrich persisted orders with email, payment info, status, and timestamps
2. Create API endpoints to query orders by email and by order ID
3. Create refund capability that flows through the payment service
4. Add a shipping status check endpoint (currently tracking IDs are fire-and-forget UUIDs)
5. Build a chatbot **order sub-agent** that uses these APIs as tools
6. Include an **error scenario** in the chatbot flow (shipping status check can fail)

Email is optional at checkout (anonymous checkout stays fine). No passwords, no user accounts, no sign-in UI.

---

## Phase 1: Schema & Proto Changes

### 1a. Database schema (`src/postgres/init.sql`)

Extend `accounting."order"` table:

```sql
CREATE TABLE accounting."order" (
    order_id TEXT PRIMARY KEY,
    email TEXT,                              -- optional, from checkout
    user_id TEXT,                            -- session UUID
    transaction_id TEXT,                     -- from payment service
    total_cost_currency_code TEXT,
    total_cost_units BIGINT,
    total_cost_nanos INT,
    order_status TEXT NOT NULL DEFAULT 'completed',  -- completed | refunded
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    refunded_at TIMESTAMPTZ
);
CREATE INDEX idx_order_email ON accounting."order"(email);
```

### 1b. Proto changes (`pb/demo.proto`)

**Extend `OrderResult`** (new fields 6-9, backwards-compatible):
```protobuf
message OrderResult {
    string order_id = 1;
    string shipping_tracking_id = 2;
    Money shipping_cost = 3;
    Address shipping_address = 4;
    repeated OrderItem items = 5;
    string user_id = 6;           // NEW
    string email = 7;             // NEW
    string transaction_id = 8;    // NEW
    Money total_cost = 9;         // NEW
}
```

**Extend `PaymentService`** with Refund and GetPaymentStatus:
```protobuf
service PaymentService {
    rpc Charge(ChargeRequest) returns (ChargeResponse) {}
    rpc Refund(RefundRequest) returns (RefundResponse) {}
    rpc GetPaymentStatus(GetPaymentStatusRequest) returns (PaymentStatus) {}
}
// + new messages: RefundRequest, RefundResponse, GetPaymentStatusRequest, PaymentStatus
```

**Add `OrderService`** (hosted in accounting service):
```protobuf
service OrderService {
    rpc GetOrdersByEmail(GetOrdersByEmailRequest) returns (GetOrdersByEmailResponse) {}
    rpc GetOrder(GetOrderRequest) returns (OrderDetail) {}
    rpc RefundOrder(RefundOrderRequest) returns (RefundOrderResponse) {}
}
// + new messages: OrderDetail, GetOrdersByEmailRequest/Response, etc.
```

### 1c. Regenerate protobuf code

For Go (checkout), C# (accounting), Node.js (payment), TypeScript (frontend/chatbot), Rust (shipping - if adding gRPC, otherwise shipping stays HTTP).

---

## Phase 2: Enrich Order Data in Checkout

### `src/checkout/main.go` (~line 385)

Populate new `OrderResult` fields:
- `UserId = req.UserId`
- `Email = req.Email` (may be empty)
- `TransactionId = txID` (from `chargeCard()`)
- `TotalCost` (already calculated)

Small change - 4 extra field assignments.

---

## Phase 3: Enriched Persistence in Accounting

### `src/accounting/Entities.cs`
Add: `Email`, `UserId`, `TransactionId`, `TotalCostCurrencyCode/Units/Nanos`, `OrderStatus`, `CreatedAt`, `RefundedAt`

### `src/accounting/Consumer.cs`
Update `ProcessMessage` to persist the new fields from the Kafka message.

---

## Phase 4: Payment Service - Refund & Status

### `src/payment/charge.js` (or new files)

**`Refund` RPC**: Simulates a refund. Generates `refund_transaction_id`, logs it, records `app.payment.refunds` counter metric. Can include feature-flag-driven failure rate.

**`GetPaymentStatus` RPC**: In-memory map of `transaction_id -> status` populated on Charge, updated on Refund. Returns "charged" or "refunded". Data lost on restart (fine for demo).

### `src/payment/index.js`
Register new handlers.

---

## Phase 5: Shipping Status Endpoint

### `src/shipping/src/shipping_service.rs`

Add a new HTTP endpoint: **`GET /shipping-status/{trackingId}`**

Returns a simulated shipping status randomly picked from: `"processing"`, `"shipped"`, `"in_transit"`, `"delivered"`. The status is deterministic per tracking ID (use the tracking ID as a hash seed) so repeated calls return the same status.

**Error scenario via feature flag**: Add a `shippingStatusFailure` feature flag (via FlagD). When enabled, the endpoint returns HTTP 503 with a delay (simulating a downstream dependency failure). This gives the chatbot an error to handle gracefully, and creates interesting error traces.

### Files to modify
- `src/shipping/src/shipping_service.rs` - add `get_shipping_status` handler
- `src/shipping/src/main.rs` - register new route

---

## Phase 6: Order Query & Refund gRPC Service (Accounting)

### New file: `src/accounting/OrderServiceImpl.cs`

- **`GetOrdersByEmail`**: Query `accounting."order"` JOIN `orderitem` JOIN `shipping` WHERE `email = ?`. Return list of `OrderDetail`.
- **`GetOrder`**: Query by `order_id`. Calls `PaymentService.GetPaymentStatus` to include payment status.
- **`RefundOrder`**:
  1. Look up order, verify email matches
  2. Check `order_status` is `"completed"`
  3. **Call `PaymentService.Refund`** with `transaction_id` + `total_cost`
  4. Update `order_status = 'refunded'`, `refunded_at = NOW()`
  5. Return success + `refund_transaction_id`

  Trace: Chatbot -> Frontend -> Accounting (gRPC) -> Payment (gRPC) -> Accounting -> PostgreSQL

### `src/accounting/Program.cs`
Add gRPC server hosting + PaymentService gRPC client.

---

## Phase 7: Frontend API Routes

HTTP routes that proxy to backend gRPC services. These are the tool-call endpoints.

### New API routes
- `GET /api/orders?email={email}` -> `OrderService.GetOrdersByEmail`
- `GET /api/orders/{orderId}` -> `OrderService.GetOrder`
- `POST /api/orders/{orderId}/refund` body `{email}` -> `OrderService.RefundOrder`
- `GET /api/shipping/{trackingId}` -> proxies to shipping service `GET /shipping-status/{trackingId}`

### New gateway
- `src/frontend/gateways/rpc/Order.gateway.ts` - gRPC client for OrderService

---

## Phase 8: Chatbot Order Sub-Agent

Extend the existing chatbot (`src/chatbot/`) with an order-handling sub-agent, following the same multi-agent pattern as the existing product flow.

### 8a. Scope classifier update (`src/chatbot/src/agents.ts`, ~line 199)

Update `SCOPE_CLASSIFIER_PROMPT` to recognize order-related questions and return a category:
```
Respond with: { "inScope": true, "category": "product" | "order" } or { "inScope": false }

IN SCOPE (product): questions about products, prices, descriptions, availability, recommendations, comparisons.
IN SCOPE (order): questions about orders, order status, shipping status, refunds, returns. Requires an email address or order ID.
```

### 8b. New sub-agent: Order Agent (`src/chatbot/src/agents.ts`)

Tool-calling agent (same pattern as `fetchProductInfo`) with these tools:

```typescript
const ORDER_TOOLS = [
  {
    name: 'lookup_orders',
    description: 'Find all orders for a customer by their email address.',
    parameters: { type: 'object', properties: { email: { type: 'string' } }, required: ['email'] }
  },
  {
    name: 'get_order',
    description: 'Get details of a specific order by order ID.',
    parameters: { type: 'object', properties: { order_id: { type: 'string' } }, required: ['order_id'] }
  },
  {
    name: 'check_shipping',
    description: 'Check the shipping status for a tracking ID.',
    parameters: { type: 'object', properties: { tracking_id: { type: 'string' } }, required: ['tracking_id'] }
  },
  {
    name: 'refund_order',
    description: 'Process a refund for an order. Requires order ID and customer email for verification.',
    parameters: { type: 'object', properties: { order_id: { type: 'string' }, email: { type: 'string' } }, required: ['order_id', 'email'] }
  }
];
```

The agent prompt instructs the LLM to:
- Ask the customer for their email if not provided
- Look up orders and provide status information
- Check shipping status when asked (this is the call that can fail - the agent must handle the error gracefully)
- Process refunds when requested, confirming with the customer first

Tool implementations call the frontend API routes (same pattern as `doProductFetch`):
- `lookup_orders` -> `GET ${FRONTEND_ADDR}/api/orders?email={email}`
- `get_order` -> `GET ${FRONTEND_ADDR}/api/orders/{orderId}`
- `check_shipping` -> `GET ${FRONTEND_ADDR}/api/shipping/{trackingId}` (**can return 503 error**)
- `refund_order` -> `POST ${FRONTEND_ADDR}/api/orders/{orderId}/refund`

### 8c. Error handling in chatbot

When `check_shipping` returns a 503 (shipping service failure via feature flag):
- The tool result returns an error message
- The LLM should respond gracefully: "I'm sorry, the shipping status system is currently unavailable. Here's what I can tell you about your order..."
- The span gets an error status, creating visible error traces in Honeycomb
- This demonstrates: error propagation across services, graceful degradation, error traces

### 8d. Supervisor update (`handleQuestion`, ~line 567)

```
1. Scope classifier -> { inScope, category }
2. If category == "product" -> existing product flow
3. If category == "order" -> order agent (tool-calling loop) -> response generator
```

The order agent may need **multiple tool-call turns** (e.g., first lookup orders, then check shipping for a specific order). This is a real agentic loop, unlike the product fetcher's hardcoded 2-turn pattern.

### 8e. HTTP endpoint update (`src/chatbot/src/index.ts`)

No changes needed to the `/chat/question` endpoint signature. The chatbot determines intent from the question text. The order agent extracts email/order ID from the conversation.

### 8f. Feature flag

Add `chatbot.orders.enabled` flag in FlagD config to gate the order capability independently.

---

## Phase 9: Infrastructure Config

### `docker-compose.yml`
- Expose new gRPC port on accounting container (e.g., 5060)
- Add `ACCOUNTING_ADDR` env var to frontend service
- Add `SHIPPING_ADDR` to chatbot/frontend if not already present

### `.env`
- Add `ACCOUNTING_SERVICE_PORT=5060`
- Add `ACCOUNTING_SERVICE_ADDR=accounting:${ACCOUNTING_SERVICE_PORT}`

### FlagD config
- Add `shippingStatusFailure` flag (number 0-1 representing failure rate)
- Add `chatbot.orders.enabled` flag (boolean)

---

## Implementation Order

```
Phase 1 (Schema + Proto)            -- foundation
    |
    ├── Phase 2 (Checkout enrich)    -- depends on proto
    ├── Phase 3 (Accounting persist) -- depends on schema + proto
    ├── Phase 4 (Payment refund)     -- depends on proto
    └── Phase 5 (Shipping status)    -- independent
    |
Phase 6 (Order gRPC service)        -- depends on 3 + 4
    |
Phase 7 (Frontend API routes)       -- depends on 6 + 5
    |
Phase 8 (Chatbot order agent)       -- depends on 7
    |
Phase 9 (Infrastructure config)     -- wire everything together
```

Phases 2-5 can be done in parallel after Phase 1.

---

## Key Files to Modify

| File | Change |
|------|--------|
| `pb/demo.proto` | Extended OrderResult + PaymentService RPCs + new OrderService |
| `src/postgres/init.sql` | Extended order table with email, status, timestamps |
| `src/checkout/main.go` (~line 385) | Populate new OrderResult fields |
| `src/accounting/Entities.cs` | Extended OrderEntity |
| `src/accounting/Consumer.cs` | Persist enriched order data |
| `src/accounting/Program.cs` | Add gRPC server + PaymentService client |
| `src/payment/charge.js` (or new files) | Add Refund + GetPaymentStatus |
| `src/payment/index.js` | Register new gRPC handlers |
| `src/shipping/src/shipping_service.rs` | Add `/shipping-status/{trackingId}` endpoint |
| `src/shipping/src/main.rs` | Register new route |
| `src/chatbot/src/agents.ts` | Order sub-agent + updated scope classifier + supervisor |
| `src/chatbot/src/index.ts` | Minor updates if needed |
| **New:** `src/accounting/OrderServiceImpl.cs` | Order query + refund gRPC |
| **New:** `src/frontend/gateways/rpc/Order.gateway.ts` | gRPC client for OrderService |
| **New:** `src/frontend/pages/api/orders.ts` | GET orders by email |
| **New:** `src/frontend/pages/api/orders/[orderId].ts` | GET order by ID |
| **New:** `src/frontend/pages/api/orders/[orderId]/refund.ts` | POST refund |
| **New:** `src/frontend/pages/api/shipping/[trackingId].ts` | GET shipping status (proxy) |
| `docker-compose.yml` | Ports, env vars |
| FlagD config | New feature flags |

---

## Verification

1. **Schema**: `docker compose up`, verify extended `accounting."order"` table
2. **Order enrichment**: Place order with email, verify DB row has all new fields
3. **Query by email**: `GET /api/orders?email=test@example.com` returns orders
4. **Query by ID**: `GET /api/orders/{orderId}` returns detail with payment status
5. **Refund flow**: `POST /api/orders/{orderId}/refund` -> payment service called -> order status updated
6. **Refund guards**: Wrong email rejected, already-refunded rejected
7. **Shipping status**: `GET /api/shipping/{trackingId}` returns simulated status
8. **Shipping error**: Enable `shippingStatusFailure` flag -> endpoint returns 503
9. **Chatbot - order lookup**: Ask "what are my orders?" -> chatbot asks for email -> returns order list
10. **Chatbot - shipping check**: Ask "where is my order?" -> checks shipping status
11. **Chatbot - shipping error**: With flag enabled, chatbot handles 503 gracefully
12. **Chatbot - refund**: Ask "I want a refund" -> chatbot processes refund via tool call
13. **Traces in Honeycomb**:
    - Checkout: enriched with email, transaction_id
    - Order query: Chatbot -> Frontend -> Accounting -> Payment -> PostgreSQL
    - Refund: Chatbot -> Frontend -> Accounting -> Payment -> PostgreSQL
    - Shipping error: Chatbot -> Frontend -> Shipping (503 error span)

## Chatbot Tool Call Summary

| Tool | Endpoint | Purpose |
|------|----------|---------|
| `lookup_orders` | `GET /api/orders?email={email}` | Find all orders for a customer |
| `get_order` | `GET /api/orders/{orderId}` | Get order details + payment status |
| `check_shipping` | `GET /api/shipping/{trackingId}` | Check shipping status (can fail!) |
| `refund_order` | `POST /api/orders/{orderId}/refund` | Process refund via payment service |

## Interesting Trace Topologies

1. **Happy path order query**: Chatbot -> LLM (classify) -> LLM (order agent + tool calls) -> Frontend -> Accounting -> Payment -> PostgreSQL -> LLM (response generator) -> User
2. **Shipping error path**: Same as above but Shipping returns 503 -> error span -> LLM gracefully handles -> User gets partial answer
3. **Refund**: Chatbot -> LLM -> Frontend -> Accounting -> Payment (refund) -> PostgreSQL (status update) -> LLM -> User
4. **Multi-turn agent**: Order agent calls `lookup_orders`, then `get_order`, then `check_shipping` in sequence - multiple tool-call turns visible as child spans
