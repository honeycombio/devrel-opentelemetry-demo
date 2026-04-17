# Plan: Persistent Orders, Order APIs, Chatbot Order Agent, and Shipping Status

## Context

The OpenTelemetry demo app has **transient orders** (the accounting service persists them to PostgreSQL but only stores `order_id` - no user association, no status, no timestamps). We need to:

1. Enrich persisted orders with email, payment info, status, and timestamps
2. Create API endpoints to query orders by email and by order ID
3. Create refund capability that flows through the payment service
4. Add a shipping status check endpoint (currently tracking IDs are fire-and-forget UUIDs)
5. Build chatbot **sub-agents** (5 distinct agents) for order status and refund flows
6. Include an **error scenario** on the refund path (payment service failure via feature flag)

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

The status is simulated - no real shipping tracking. This endpoint is straightforward and always succeeds.

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

## Phase 8: Chatbot Sub-Agents for Order Flow

The chatbot uses a **supervisor + sub-agent** pattern. Each step in the conversation spawns a **distinct sub-agent** with its own span, LLM call, and/or tool call. This creates rich, readable trace trees.

### Target conversation flow

```
User:  "I haven't received my order, my email is alice@example.com"
        → Intent Classifier    → "order_status"
        → Order Lookup          → finds order, gets tracking ID
        → Shipping Status       → queries shipping service
        → Response Generator    → "Your order #X is due to ship on Monday"

User:  "That's too late, I want a refund"
        → Intent Classifier    → "refund"
        → Refund Processor      → calls payment service (CAN FAIL)
        → Response Generator    → "Certainly, your refund has been processed"
                                   or "I'm sorry, I wasn't able to process your refund..."
```

### 8a. Sub-agent 1: Intent Classifier

Determines what the user wants. Returns a structured classification.

- **Span**: `invoke_agent intent_classifier`
- **LLM call**: Single chat completion
- **Prompt**: Classify the user's message into one of: `order_status`, `refund`, `product`, `out_of_scope`
- **Output**: `{ "intent": "order_status" | "refund" | "product" | "out_of_scope" }`
- **Replaces** the existing `classifyScope` for order-related flows

### 8b. Sub-agent 2: Order Lookup

Finds the customer's order and retrieves details. Tool-calling agent.

- **Span**: `invoke_agent order_lookup`
- **LLM call**: Chat with tools, potentially multi-turn
- **Tools**:
  - `lookup_orders` → `GET ${FRONTEND_ADDR}/api/orders?email={email}`
  - `get_order` → `GET ${FRONTEND_ADDR}/api/orders/{orderId}`
- **Output**: Order details JSON (order ID, tracking ID, items, status, etc.)
- **Trace shape**: Chatbot → LLM → `execute_tool lookup_orders` → Frontend → Accounting → PostgreSQL

### 8c. Sub-agent 3: Shipping Status Checker

Checks shipping status for a specific tracking ID. Single tool call.

- **Span**: `invoke_agent shipping_checker`
- **LLM call**: Chat with tool
- **Tool**: `check_shipping` → `GET ${FRONTEND_ADDR}/api/shipping/{trackingId}`
- **Output**: Shipping status (processing / shipped / in_transit / delivered) with estimated dates
- **Trace shape**: Chatbot → LLM → `execute_tool check_shipping` → Frontend → Shipping Service

### 8d. Sub-agent 4: Refund Processor

Processes a refund for an order. This is the **action** sub-agent — it mutates state.

- **Span**: `invoke_agent refund_processor`
- **LLM call**: Chat with tool
- **Tool**: `refund_order` → `POST ${FRONTEND_ADDR}/api/orders/{orderId}/refund`
- **Output**: Refund result (success + refund transaction ID, or error)
- **Trace shape**: Chatbot → LLM → `execute_tool refund_order` → Frontend → Accounting → Payment Service → PostgreSQL
- **Error scenario**: The Payment Service `Refund` RPC can fail via the `paymentServiceFailure` feature flag. When this happens:
  - The tool returns an error result to the LLM
  - The refund_processor span gets error status
  - The trace shows: Chatbot → Accounting → Payment (ERROR) → back to Accounting (rolls back)
  - The Response Generator receives the error context and explains the failure to the user

### 8e. Sub-agent 5: Response Generator

Composes the final human-readable answer from the data gathered by previous sub-agents. Same pattern as the existing product response generator.

- **Span**: `invoke_agent response_generator`
- **LLM call**: Single chat completion
- **Input**: The user's question + context from previous sub-agents (order details, shipping status, or refund result)
- **Output**: HTML-formatted response for the user
- **Handles both success and error cases** — if the refund failed, it explains why and suggests next steps

### 8f. Supervisor orchestration

The supervisor routes based on intent and chains the appropriate sub-agents:

```
handleQuestion(question, conversationHistory)
  │
  ├─ Intent Classifier → intent
  │
  ├─ if "order_status":
  │    Order Lookup → orderDetails
  │    Shipping Status Checker → shippingStatus
  │    Response Generator(orderDetails + shippingStatus) → answer
  │
  ├─ if "refund":
  │    Order Lookup → orderDetails  (need order ID to refund)
  │    Refund Processor(orderDetails) → refundResult (may error!)
  │    Response Generator(refundResult) → answer
  │
  ├─ if "product": → existing product flow
  └─ if "out_of_scope": → "Sorry, I can't help with that"
```

The supervisor needs **conversation history** so that on the second turn ("I want a refund"), it knows which order the user is talking about. The frontend passes conversation history with each request.

### 8g. HTTP endpoint update (`src/chatbot/src/index.ts`)

Update `/chat/question` to accept conversation history:
```typescript
// Request body
{ question: string, conversationHistory?: Array<{role: string, content: string}>, email?: string }
```

### 8h. Feature flags

- `chatbot.orders.enabled` — gates the order flow (boolean)
- `paymentServiceFailure` — existing-style flag, causes `PaymentService.Refund` to fail randomly (number 0-1 representing failure rate)

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
- Add `paymentServiceFailure` flag (number 0-1 representing refund failure rate)
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
| `src/chatbot/src/agents.ts` | 5 new sub-agents: intent_classifier, order_lookup, shipping_checker, refund_processor, response_generator + supervisor update |
| `src/chatbot/src/index.ts` | Accept conversationHistory in /chat/question |
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
9. **Chatbot - order status flow**: "I haven't received my order" → spawns intent_classifier → order_lookup → shipping_checker → response_generator as separate sub-agent spans
10. **Chatbot - refund flow**: "I want a refund" → spawns intent_classifier → order_lookup → refund_processor → response_generator as separate sub-agent spans
11. **Chatbot - refund error**: Enable `paymentServiceFailure` flag → refund_processor tool call fails → response_generator explains the error
12. **Traces in Honeycomb**:
    - Each sub-agent visible as a distinct `invoke_agent` span under the supervisor
    - Tool calls visible as `execute_tool` child spans within each sub-agent
    - Error path: refund_processor span has error status, Payment Service span shows the failure
    - 5 sub-agent spans per turn, creating a wide trace tree

## Chatbot Sub-Agents Summary

| Sub-Agent | Tools | When Used |
|-----------|-------|-----------|
| Intent Classifier | (none - LLM only) | Every turn |
| Order Lookup | `lookup_orders`, `get_order` | Order status + refund flows |
| Shipping Status Checker | `check_shipping` | Order status flow |
| Refund Processor | `refund_order` | Refund flow (can error!) |
| Response Generator | (none - LLM only) | Every turn |

## Tool Endpoints

| Tool | Endpoint | Purpose |
|------|----------|---------|
| `lookup_orders` | `GET /api/orders?email={email}` | Find all orders for a customer |
| `get_order` | `GET /api/orders/{orderId}` | Get order details + payment status |
| `check_shipping` | `GET /api/shipping/{trackingId}` | Check shipping status |
| `refund_order` | `POST /api/orders/{orderId}/refund` | Process refund via payment service |

## Trace Topologies

### Turn 1: "I haven't received my order"
```
supervisor
  ├─ invoke_agent intent_classifier
  │    └─ chat intent_classifier (LLM)          → "order_status"
  ├─ invoke_agent order_lookup
  │    ├─ chat order_lookup (LLM)                → calls lookup_orders tool
  │    ├─ execute_tool lookup_orders              → Frontend → Accounting → PostgreSQL
  │    └─ chat order_lookup (LLM)                → returns order data
  ├─ invoke_agent shipping_checker
  │    ├─ chat shipping_checker (LLM)            → calls check_shipping tool
  │    ├─ execute_tool check_shipping             → Frontend → Shipping Service
  │    └─ chat shipping_checker (LLM)            → returns shipping status
  └─ invoke_agent response_generator
       └─ chat response_generator (LLM)          → "Your order is due to ship Monday"
```

### Turn 2 (happy): "That's too late, I want a refund"
```
supervisor
  ├─ invoke_agent intent_classifier
  │    └─ chat intent_classifier (LLM)          → "refund"
  ├─ invoke_agent order_lookup
  │    └─ (uses order from conversation context, or re-fetches)
  ├─ invoke_agent refund_processor
  │    ├─ chat refund_processor (LLM)            → calls refund_order tool
  │    ├─ execute_tool refund_order               → Frontend → Accounting → Payment → PostgreSQL
  │    └─ chat refund_processor (LLM)            → returns refund confirmation
  └─ invoke_agent response_generator
       └─ chat response_generator (LLM)          → "Certainly, your refund has been processed"
```

### Turn 2 (error): Refund fails via payment service feature flag
```
supervisor
  ├─ invoke_agent intent_classifier              → "refund"
  ├─ invoke_agent order_lookup                   → order details
  ├─ invoke_agent refund_processor
  │    ├─ chat refund_processor (LLM)            → calls refund_order tool
  │    ├─ execute_tool refund_order               → Frontend → Accounting → Payment (ERROR!) 
  │    │                                            ↑ PaymentService.Refund fails
  │    └─ chat refund_processor (LLM)            → returns error context
  └─ invoke_agent response_generator
       └─ chat response_generator (LLM)          → "I'm sorry, I wasn't able to process your refund..."
```
