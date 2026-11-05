# AI Support Agent Specification

## Purpose

A Telescope Shop customer who has bought something asks a support assistant, in plain language, where their order is and whether it can be refunded. The assistant is an AI workload: a supervisor agent and two sub-agents on a hosted LLM, which answer from real order, payment and shipping data (no canned answers), remember the conversation between turns, and have a sample of their answers scored by an LLM judge for bias, hallucination and relevance. The demo exists so that people and agents using Honeycomb can investigate an AI application: multi-agent traces (supervisor, sub-agents, tool calls, backend hops down to the database and payment), GenAI telemetry with conversation ids, token usage, cache and cost data, and quality scores next to the trace that produced them.

Four stories run on it:

- "One conversation has a token spike": a customer pastes a long forwarded email thread into one turn.
- "Tokens per conversation creep up": orders pile up for a few customers and the order list fed back to the model grows (flag `storechatRefundBackupOrders`).
- "Customers see random errors": a conversation-store failure (flag `storechatConversationFailure`) and refund failures on the payment path (flag `paymentServiceRefundFailure`), the latter visible only at the bottom of the call chain and traced upward to the customer's HTTP 500.
- "Find the chat turns with a low hallucination score, open the trace and see which tool result the model ignored", plus "what do evals cost and how long do they take".

For any of this to exist, orders are kept after checkout, found again by the customer's email, show live payment state, can be refunded, and have a shipping status. That data and those interfaces belong to this use case.

## Apps affected

- `store-chat`: hosts the chat page, the chat API, the agents and the conversation memory; evaluates the conversation failure flag.
- `llm-evals`: consumes one span per chat turn and scores a sample of them. It is not on the customer's request path.
- `frontend-proxy`: exposes `store-chat` to browsers under `/store-chat/`.
- `frontend`: exposes the order HTTP routes and documents its public API routes in the OpenAPI document.
- `checkout`: puts customer, payment and total information on the order it returns and publishes to the `orders` Kafka topic.
- `accounting`: stores enriched orders from the `orders` topic; serves the gRPC service `OrderService`; validates and records refunds; asks payment for live status and refunds.
- `postgresql`: schema, index and expiry job for stored orders.
- `payment`: remembers charges, reports payment status, refunds charges, hosts the refund failure scenario.
- `shipping`: answers shipping status lookups on its HTTP port; its price quote and ship-order routes are unaffected.
- `flagd`: holds `paymentServiceRefundFailure`, `storechatConversationFailure` and `storechatRefundBackupOrders`.
- `kafka`: carries scored spans to `llm-evals`; auto-created topics have 8 partitions.
- `otel-collector`: selects the span to score and exports it to Kafka.
- `load-generator`: places checkouts with emails and drives chat traffic.
- `cart` (Valkey): the cart's Valkey instance stores conversation memory.

## Requirements

### Requirement: Customers get order status and refunds from a chat assistant

The `store-chat` service SHALL serve a single-page chat UI at `/` and a JSON chat API at `POST /chat`, and SHALL answer `GET /health` with HTTP 200 and `{"status": "ok"}` without calling any model or backend. The chat request body SHALL have `question` (string, required), `sessionId` (string, required) and `email` (string, optional). The response body SHALL be `{"response": "<assistant text>"}`. The service SHALL listen on the port in `STORE_CHAT_PORT` (default `8080`) and report itself as service `store-chat` unless `OTEL_SERVICE_NAME` says otherwise.

#### Scenario: Customer chats

- **WHEN** a browser opens the chat page, enters an email, and sends "Where is my order?"
- **THEN** the page posts to the chat API with the question, the browser session's id and the email, and shows the assistant's plain-text reply

#### Scenario: Health probe

- **WHEN** `GET /health` is called
- **THEN** it returns HTTP 200 with `{"status": "ok"}`

### Requirement: The chat page keeps one conversation and shows failures

The chat page SHALL show the heading "Telescope Shop - Order Assistant" (browser tab title "Telescope Shop - Store Chat"), an email field remembered for the browser tab's session, a message list and a send button (Enter also sends). The email is sent only when filled in. The page SHALL generate a random session id once per browser tab session and reuse it for every message, so follow-up questions share a conversation. It SHALL show a typing indicator while waiting and start with a welcome message saying the assistant can check order status or process a refund and asking for the email. It SHALL call the chat API under the `/store-chat/` prefix. When the API call fails, it SHALL show "Sorry, something went wrong: HTTP `<status>`" as an assistant message and let the customer try again.

#### Scenario: API failure is visible, not fatal

- **WHEN** the chat API returns HTTP 500
- **THEN** the page shows "Sorry, something went wrong: HTTP 500" and the send button works again

### Requirement: Chat is reachable at /store-chat/ through the front door

The frontend proxy SHALL route `/store-chat/` to the `store-chat` service with the prefix removed and with no route timeout (chat replies can be slow), and SHALL redirect `/store-chat` to `/store-chat/`. These routes MUST come before the proxy's catch-all route. They use their own proxy cluster named `store-chat`, whose address comes from the proxy's `STORE_CHAT_HOST` and `STORE_CHAT_PORT` settings.

#### Scenario: Open chat

- **WHEN** a browser requests `/store-chat`
- **THEN** it is redirected to `/store-chat/` and then served by `store-chat`

#### Scenario: Chat API through the front door

- **WHEN** a client posts to `/store-chat/chat`
- **THEN** `store-chat` receives the request at `/chat` and the call is not cut off by a route timeout

### Requirement: Each turn is a supervisor with two sub-agents

Each chat turn SHALL be handled by a customer-facing supervisor agent (`gen_ai.agent.name` = `supervisor`) and two sub-agents it calls as tools: an order status agent (`order_status_agent`) and a refund agent (`refund_agent`). The supervisor has two tools, `check_order_status(question, email)` and `process_refund(question, email)`, each running the matching sub-agent and returning its text; the supervisor composes the final reply from what they return. Every agent's telemetry SHALL carry `gen_ai.conversation.id` equal to the request's `sessionId` and `gen_ai.agent.name` equal to its own name; the request's server span SHALL also carry `gen_ai.conversation.id`.

The agent run for a turn SHALL appear as a span named `invoke_agent supervisor` with the GenAI attributes `gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.request.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.response.finish_reasons` and `gen_ai.server.time_to_first_token`. That span name and those attributes are the contract for the evaluation and for dashboards.

#### Scenario: Order status question

- **WHEN** a customer with an email asks "Has my package shipped yet?"
- **THEN** one trace shows the HTTP request, an `invoke_agent supervisor` span, a call to `check_order_status`, an `order_status_agent` run with its tool calls, and the model calls, and every agent span carries the same `gen_ai.conversation.id`

#### Scenario: Refund request

- **WHEN** a customer asks for a refund of their most recent order
- **THEN** the supervisor calls `process_refund` and the refund agent runs lookup, confirm and refund

### Requirement: Answers come from real backend calls

The sub-agents SHALL have these tools, each backed by a real backend call:

- `lookup_orders(email)`: gRPC `GetOrdersByEmail` of `OrderService` (proto package `oteldemo`) on accounting, request `{email}`, no paging parameter.
- `get_order(order_id)`: `GetOrder` with `{order_id}`.
- `refund_order(order_id, email)`: `RefundOrder` with `{order_id, email}`. Errors (email mismatch, already refunded, payment failure) come back as gRPC errors.
- `check_shipping(tracking_id)`: `GET /shipping-status/{tracking_id}` on the shipping service's HTTP port.

The order status agent has `lookup_orders`, `get_order` and `check_shipping`. The refund agent has `lookup_orders`, `get_order` and `refund_order`. Backend addresses come from `ACCOUNTING_ADDR` (default `accounting:5060`) and `SHIPPING_ADDR` (default `http://shipping:8080`). Tools return backend data to the model as JSON with camel-case field names (the refund tool returns `success`, `status`, `refundTransactionId`).

The sub-agents SHALL be instructed to: return concise structured summaries; never invent data that tools did not return; report empty results and tool failures plainly and retry at most once; never claim a refund succeeded when `refund_order` returned an error; and, when a refund request is ambiguous between several orders, return the candidates and stop rather than guess.

#### Scenario: Refund really refunds

- **WHEN** the refund agent calls `refund_order` for an order and the email matches
- **THEN** the order's refund state changes in the order store, and the customer is told the transaction id the backend returned

#### Scenario: Backend failure is not hidden

- **WHEN** a backend call fails (for example a refund fails because `paymentServiceRefundFailure` is on)
- **THEN** the failure shows as an error on the tool span, and the reply says the detail is unavailable instead of inventing it

### Requirement: The assistant stays in scope and in persona

The supervisor SHALL speak as the Telescope Shop assistant (never "the AI"), in plain text, and offer only order status and refunds. It SHALL ask for an email when it has none and use the email from the request when given (passed to the agent as a `[Customer email: ...]` line before the question). It SHALL tell customers that product questions, cancellations, address changes, stock and pricing are out of scope, pointing them to `support@telescopeshop.example`. It SHALL NOT invent tracking numbers, carriers, delivery dates, refund amounts or transaction ids, SHALL NOT reveal one customer's data to another, and SHALL say honestly that it is an automated assistant if asked.

#### Scenario: Out-of-scope question

- **WHEN** a customer asks whether a 12mm eyepiece is in stock
- **THEN** the reply says it can only help with orders and refunds, and does not make up stock data

### Requirement: Follow-up questions use the conversation so far

`store-chat` SHALL keep the history of each `sessionId` in the cart's Valkey (address `VALKEY_ADDR`, default `valkey-cart:6379`) under a key starting with `storechat:session:`, as a list of `{role, content}` messages. Before each turn it SHALL load the history and give it to the agent as earlier messages. After each successful turn it SHALL append the customer's original question (without the `[Customer email: ...]` line) and the assistant's final reply; intermediate tool exchanges are not kept. The history SHALL expire one hour (3600 s) after the last write. A new or expired session starts empty.

#### Scenario: Follow-up uses earlier context

- **WHEN** a customer asks about their latest order and then asks "when will it arrive?" with the same `sessionId`
- **THEN** the second turn is answered with the first turn's question and answer as context

#### Scenario: Expired session

- **WHEN** no turn has used a `sessionId` for more than an hour
- **THEN** the next turn starts with an empty history

### Requirement: Model choice and prompt caching make cost visible

The service SHALL call AWS Bedrock with one model per agent role: the supervisor uses `BEDROCK_MODEL_ID`, falling back to `BEDROCK_HAIKU_PROFILE_ARN`; the order status agent uses `BEDROCK_NOVA_LITE_PROFILE_ARN`; the refund agent uses `BEDROCK_NOVA_MICRO_PROFILE_ARN`. When a sub-agent's variable is empty it uses the supervisor's model. The supervisor writes the customer-facing reply and uses the strongest (Claude Haiku class) model; the sub-agents are mechanical tool chains on much cheaper models, so different `gen_ai.request.model` values per agent are expected.

Every model call SHALL have an output cap of 1024 tokens. Prompt caching SHALL be on for the supervisor only, for its system prompt and tool definitions, and off for sub-agents, whose models reject it. The per-turn message tail SHALL NOT be cached, because its writes cost more than the reads save. The supervisor's system prompt SHALL begin with a long "customer service handbook" (brand voice, personas, refund policy summary, worked examples, order lifecycle and carrier references, privacy rules), identical for every session and turn, large enough together with the tool definitions to pass the provider's minimum cacheable size (about 2048 tokens for the Haiku class). Sub-agents have short task-specific prompts.

#### Scenario: Caching shows in telemetry

- **WHEN** many chat turns run within the provider's cache lifetime
- **THEN** supervisor model calls show large cache-read input token counts and near-zero cache writes, while sub-agent calls show no cache usage

### Requirement: Checkout keeps the customer, payment and total on the order

The `OrderResult` message that checkout returns and publishes to the `orders` Kafka topic SHALL carry `order_id`, `shipping_tracking_id`, `shipping_cost`, `shipping_address`, the ordered items, and also `user_id` (field 6, the session id supplied in the place-order request), `email` (field 7, as supplied, possibly empty), `transaction_id` (field 8, the id returned by the payment charge) and `total_cost` (field 9, a `Money` in the customer's selected currency, the amount actually charged including tax and shipping). Fields 6 to 9 are optional, so a reader that does not know them keeps working.

#### Scenario: Checkout with an email

- **WHEN** an order is placed with email `someone@example.com` and the charge returns transaction id `T`
- **THEN** the order result and the Kafka message have that email, `T`, the caller's `user_id`, and `total_cost` equal to the amount charged

### Requirement: Email is optional at checkout

Checkout SHALL accept an order with no email. Such an order is placed, charged, published and stored normally and is never returned by an email lookup. There are no accounts or passwords; the email is only a lookup key.

#### Scenario: Anonymous checkout

- **WHEN** an order is placed with an empty email
- **THEN** the order succeeds and is stored with no email, and no lookup by any email returns it

### Requirement: Every order is persisted with customer, payment and status data

For each consumed order message the accounting service SHALL store the order's line items and shipping record and also: email, user id, transaction id, total cost (currency code, units, nanos), an order status, a creation timestamp and a refund timestamp. The order table has columns for these, status not null with default `completed`, creation time not null with default now, and an index on email. Empty email, user id and transaction id are stored as absent. A new order has status `completed`, creation time of now and no refund time; the only stored statuses are `completed` and `refunded`. The database roles that read the order table also read these columns.

#### Scenario: New order stored

- **WHEN** a valid order message with email and total is consumed
- **THEN** the stored order has status `completed`, a creation time of now, no refund time, and the email, user id, transaction id and total from the message

### Requirement: Order storage loses nothing and never duplicates

Accounting SHALL commit a Kafka message offset only after the order is stored, so a database failure causes redelivery (after a short pause) instead of loss. A message whose order id is already stored, including one that appears between the existence check and the write, is treated as handled without duplicate or failure. A message that cannot be parsed is dropped and logged as an error. When no database is configured the service still consumes and logs orders without storing them, and still starts and serves its gRPC port.

#### Scenario: Replay after restart

- **WHEN** accounting restarts and receives an order message it already stored
- **THEN** no second order is created and the message is committed

#### Scenario: Database unavailable

- **WHEN** the database rejects the write for a valid message
- **THEN** the failure is logged, the message is not committed, and it is retried until the database accepts it

### Requirement: Orders expire after 48 hours

The database SHALL delete stored orders older than 48 hours, checked hourly, together with their line items and shipping records. This keeps the database small and bounds how many orders a reused customer email accumulates.

#### Scenario: Old order removed

- **WHEN** an order was created more than 48 hours ago and the hourly cleanup runs
- **THEN** the order, its items and its shipping record are gone and lookups no longer return it

### Requirement: Accounting serves OrderService on port 5060

Accounting SHALL serve the gRPC service `OrderService` (proto package `oteldemo`) over HTTP/2 without TLS on port 5060, with:

- `GetOrdersByEmail(GetOrdersByEmailRequest{email}) -> GetOrdersByEmailResponse{orders: [OrderDetail]}`
- `GetOrder(GetOrderRequest{order_id}) -> OrderDetail`
- `RefundOrder(RefundOrderRequest{order_id, email}) -> RefundOrderResponse{success, status, refund_transaction_id}`

`OrderDetail` has `order_id`, `email`, `status`, `total_cost` (Money: currency code, units, nanos), `shipping_tracking_id`, `shipping_address` (street, city, state, country, zip code), `items` (product id, quantity and cost per line), `created_at` (ISO 8601 UTC string) and `transaction_id`.

#### Scenario: Detail contents

- **WHEN** `GetOrder` is called for a stored order
- **THEN** the response has the items with their costs, the shipping tracking id and address, the total, the creation time and the transaction id

### Requirement: Lookup by email returns the 10 most recent orders

`GetOrdersByEmail` SHALL return only orders whose email equals the request email, newest first, capped at 10. The cap exists because a customer email can be reused, and an unbounded list would grow every time a caller includes it. It returns the stored status (`completed` or `refunded`) without calling payment. No matching orders gives an empty list, not an error.

#### Scenario: More than 10 orders

- **WHEN** an email has 15 stored orders
- **THEN** the response has the 10 newest, newest first

#### Scenario: Unknown email

- **WHEN** the email has no orders
- **THEN** the response is an empty list

### Requirement: Order detail shows live payment status

`GetOrder` SHALL return `NOT_FOUND` for an unknown order id. For an order with a transaction id it SHALL ask payment for the transaction's status and return it as the detail's `status`: `charged`, `refunded` or `unknown` (payment has no record of the transaction, for example after a payment restart). If the payment lookup fails, the call still succeeds with the order's stored status and logs a warning.

#### Scenario: Live status

- **WHEN** an order was charged and not refunded
- **THEN** `GetOrder` reports `charged` while `GetOrdersByEmail` reports `completed`

#### Scenario: Payment down

- **WHEN** payment cannot be reached during `GetOrder`
- **THEN** the order is returned with its stored status

### Requirement: Payment remembers every charge and reports its status

Payment SHALL record every successful charge (including those for synthetic requests) by transaction id with status `charged` and the amount, in memory only; the record is lost on restart. `PaymentService` offers `GetPaymentStatus(GetPaymentStatusRequest{transaction_id}) -> PaymentStatus{transaction_id, status, amount}` where status is `charged`, `refunded`, or `unknown` for a transaction with no record (amount then absent); it never fails for an unknown id. The `charge` span carries `demo.payment.transaction.id`.

#### Scenario: Charge is recorded

- **WHEN** a charge succeeds with transaction id `T`
- **THEN** a status request for `T` reports `charged` and the charged amount

#### Scenario: Unknown transaction

- **WHEN** the status of a never-charged (or pre-restart) transaction id is requested
- **THEN** the status is `unknown`

### Requirement: Payment refunds a charge

`PaymentService` SHALL offer `Refund(RefundRequest{transaction_id, amount, email}) -> RefundResponse{refund_transaction_id, success}`. A successful refund returns a newly generated `refund_transaction_id` and `success` true, marks the transaction `refunded` (keeping its amount), logs that the refund is complete, and adds 1 to the counter `demo.payment.refunds` (unit `{refund}`, no attributes). The refund runs in a span named `refund` that carries `demo.payment.transaction.id` (the refunded transaction) on success and is marked as an error with the recorded exception on failure. Payment does not reject a repeat refund and does not require the transaction to be in its memory; the repeat-refund rule belongs to accounting.

#### Scenario: Successful refund

- **WHEN** payment refunds charged transaction `T`
- **THEN** it returns a new refund transaction id and success, the counter goes up by one, and status for `T` is `refunded`

### Requirement: Refunds are validated, then paid, then recorded

Accounting's `RefundOrder` SHALL: fail with `NOT_FOUND` if the order does not exist; fail with `PERMISSION_DENIED` if the request email does not match the order's email (ignoring case); fail with `FAILED_PRECONDITION` if the stored status is not `completed`; otherwise call payment `Refund` with the order's transaction id, total cost and email, and only if that succeeds set the status to `refunded` and the refund time to now. It returns `success`, status `refunded` and the refund transaction id. If payment fails, the error is returned and the order stays `completed`.

#### Scenario: Refund succeeds

- **WHEN** the matching email asks to refund a `completed` order and payment succeeds
- **THEN** the response is success with status `refunded`, and the stored order is `refunded` with a refund time

#### Scenario: Wrong email

- **WHEN** a different email asks to refund the order
- **THEN** the request fails with `PERMISSION_DENIED` and nothing changes

#### Scenario: Second refund

- **WHEN** a refund is requested for an already refunded order
- **THEN** the request fails with `FAILED_PRECONDITION` and payment is not called

### Requirement: Order routes are available over HTTP

The frontend SHALL expose these routes, instrumented like its other API routes, answering other HTTP methods with 405 and an empty body:

- `GET /api/orders?email=<email>`: 200 with a JSON array of order details (empty when none or when `email` is missing).
- `GET /api/orders/{orderId}`: 200 with one order detail.
- `POST /api/orders/{orderId}/refund` with JSON body `{ "email": "<email>" }`: 200 with `{ success, status, refundTransactionId }`.

JSON field names are the camel-case forms of the RPC field names. Errors from accounting or payment (not found, email mismatch, already refunded, payment failure) SHALL surface as HTTP 500 with no friendlier mapping, because the error is part of the intended trace data. The frontend needs the accounting address in its environment and starts after accounting.

#### Scenario: Orders by email

- **WHEN** `GET /api/orders?email=someone@example.com` is called
- **THEN** the trace shows frontend, then accounting, then the database, and the body is the array of that customer's orders

#### Scenario: Wrong method

- **WHEN** `DELETE /api/orders/abc` is called
- **THEN** the response is 405

### Requirement: The OpenAPI document describes every public route

The repository's OpenAPI document (3.0.3, title "OpenTelemetry Demo - Telescope Shop API") SHALL describe every public frontend API route, including the three order routes (operation ids `getOrdersByEmail`, `getOrderDetail`, `refundOrder`) and the `OrderResult` with the fields above, plus schemas `OrderDetail` and `RefundResponse`. The refund route description names the flag `paymentServiceRefundFailure` as the control of payment errors and lists its failure causes (email mismatch, already refunded, payment error, all answered with 500). Tools that call the API are modelled on this document, so it changes in the same change as any route it describes.

#### Scenario: Document completeness

- **WHEN** a frontend API route is added or removed
- **THEN** the OpenAPI document is changed in the same change

### Requirement: Shipping status is answered for any tracking id, consistently

The shipping service SHALL serve `GET /shipping-status/{trackingId}` on its HTTP port (`SHIPPING_PORT`). It always answers 200 with `{ "tracking_id": "<id>", "status": "<status>", "estimated_delivery": "<YYYY-MM-DD>" }` for any tracking id, even one never issued, because the status is simulated. The tracking ids are those the ship-order route returns. The route is not exposed through the frontend's public API; callers such as the assistant's tools reach the shipping service directly.

`status` is one of `processing`, `shipped`, `in_transit`, `delivered`, and the same tracking id always gives the same status. It is derived from the tracking id alone: the sum of its byte values modulo 4 picks among those four values in the order listed. `estimated_delivery` is today's date (UTC) plus (the same sum modulo 7) days, so it is relative to the current day.

#### Scenario: Any tracking id

- **WHEN** the route is called with any non-empty tracking id
- **THEN** the response is 200 with the three fields, `tracking_id` equal to the requested id

#### Scenario: Derivation

- **WHEN** the tracking id's byte values sum to 7
- **THEN** the status is `delivered` (7 mod 4 = 3) and the estimated delivery is today plus 0 days (7 mod 7 = 0)

### Requirement: Shipping status lookups are logged

Each lookup SHALL emit a log record named `GetShippingStatus` with fields `tracking_id`, `status` and `estimated_delivery`, message "Shipping status retrieved", correlated with the request trace.

#### Scenario: Log

- **WHEN** a status is looked up
- **THEN** a log record with that name, fields and message is emitted, correlated with the request trace

### Requirement: Flag paymentServiceRefundFailure makes refunds fail

The flagd demo configuration SHALL define `paymentServiceRefundFailure` as a numeric flag, state `ENABLED`, whose value is the probability that a refund fails. Variants: `100%` = 1, `90%` = 0.95, `75%` = 0.75, `50%` = 0.5, `25%` = 0.25, `10%` = 0.1, `off` = 0. Default `off`. Description: "Fail payment service refund requests n%". Payment evaluates the flag on every refund with a default of 0; when the value is 0, or the flag cannot be read (for example flagd is unreachable), no refund fails because of the flag. When the value is above 0:

- each refund fails with probability equal to the value, with message "Refund request failed.";
- a refund for a customer whose email contains `125@` (for example `user125@example.com`) always fails with the message "Payment processor declined the refund request.", so one customer hits the error deterministically while the flag is on.

A failed refund is an error span in payment, propagates up the trace to accounting and the frontend (HTTP 500) and to the assistant's tool span, leaves the order `completed`, and changes neither the transaction's payment status nor the refund counter.

#### Scenario: Flag off

- **WHEN** the flag is `off`
- **THEN** every valid refund succeeds, including for `125@` emails

#### Scenario: Flag at 100%

- **WHEN** the flag is `100%` and a refund is requested
- **THEN** it fails with "Refund request failed.", the order remains `completed` and the refund counter does not increase

#### Scenario: Targeted customer

- **WHEN** the flag is `10%` and `user125@example.com` requests refunds
- **THEN** each one fails, while other customers fail only about 10% of the time

### Requirement: Flag storechatConversationFailure makes chat turns fail

The flag file SHALL define `storechatConversationFailure` as a boolean flag, state `ENABLED`, variants `on` = true and `off` = false, default `off`, description "Simulate conversation store failures in store chat (1-in-5 when enabled)". `store-chat` reads it from flagd (host `FLAGD_HOST`, default `flagd`; OFREP HTTP port `FLAGD_OFREP_PORT`, default `8016`), live on each history read without caching, with a 2-second timeout. If the flag cannot be evaluated (flagd unreachable, non-200 answer) it behaves as off.

When on, each read of conversation history SHALL fail with probability 1 in 5, before the Valkey call is made, with a connection error ("Failed to connect to conversation store") that is not caught, so the chat API answers HTTP 500. History is read three times per turn: once at the start, and once for each of the two messages (question, then reply) appended when the turn is saved. Each read rolls separately, so while the flag is on roughly half of the turns fail somewhere. A failure at the start happens before any model call. A failure while saving loses the reply of a turn whose model calls already ran and were paid for: if the first append fails neither message is stored, and if the second fails the question is stored without its reply.

#### Scenario: Flag off keeps history reliable

- **WHEN** the flag is off
- **THEN** no history read fails because of the simulation

#### Scenario: Flag on

- **WHEN** the flag is on and many turns run
- **THEN** about one in five history reads fails, the client gets HTTP 500, the server span has an error status with the exception, and a failed turn's trace shows no model call when the failure is at the start, or a complete agent run when the failure is at save time

### Requirement: Flag storechatRefundBackupOrders makes tokens per conversation grow

The flag file SHALL define `storechatRefundBackupOrders` as a numeric flag, state `ENABLED`, variants `on` = 1 and `off` = 0, default `off`, description "Drive store-chat refund traffic against a small fixed pool of customer emails so orders accumulate and the order list fed back to the model grows, inflating LLM input tokens per conversation". The values are numbers because the load generator evaluates the flag as an integer and treats 0 or less as off. `store-chat` itself does nothing special for this flag.

By default every chat session uses a fresh customer email, so order lookups stay small. While the flag is on, the load generator runs refund conversations against a small fixed pool of emails, so orders pile up per email, the `lookup_orders` result fed back to the model grows with every order, and so does the input token count per conversation. The growth is bounded: lookup returns at most 10 orders per email and orders expire after 48 hours, so average `gen_ai.usage.input_tokens` climbs while the pool fills and then levels off.

#### Scenario: Flag on for a while

- **WHEN** the flag stays on while the pooled emails collect orders
- **THEN** `lookup_orders` results for the pooled emails grow up to 10 orders each, and average `gen_ai.usage.input_tokens` per conversation rises

#### Scenario: Flag read as an integer

- **WHEN** the load generator reads the flag while `on` is selected
- **THEN** it gets a value above 0

### Requirement: A pasted long question produces a token spike

The chat API SHALL NOT limit or truncate `question`. A customer who pastes a long forwarded email thread into one turn produces a single conversation whose `gen_ai.usage.input_tokens` is an order of magnitude above normal.

#### Scenario: Pasted email thread

- **WHEN** a turn contains tens of kilobytes of pasted text
- **THEN** the turn succeeds and its input token count is far above the typical turn

### Requirement: Kafka topics are created with 8 partitions

The Kafka broker SHALL create every automatically created topic with 8 partitions, including `llm-evals-spans`. Consumers therefore must not rely on a single partition, and the evaluation consumer processes partitions in parallel.

#### Scenario: First message to a new topic

- **WHEN** a producer sends to a topic that does not exist
- **THEN** the topic is created with 8 partitions

### Requirement: One anchor span per chat turn reaches the evaluator

The telemetry collector SHALL export to the Kafka topic `llm-evals-spans`, as OTLP-JSON trace messages, only the `invoke_agent supervisor` span of service `store-chat`, once per chat turn. It SHALL make sure the GenAI token attributes carry the names in this spec and that input and output messages are present as span attributes. Chat code publishes nothing itself.

`llm-evals` SHALL consume that topic (brokers from `KAFKA_ADDR`, required; the service exits at start if unset), in consumer group `llm-evals`, starting from new messages only. Each message holds one or more spans. From each span it reads `gen_ai.input.messages` and `gen_ai.output.messages` (JSON strings), `gen_ai.agent.name`, `gen_ai.request.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.server.time_to_first_token` and `gen_ai.response.finish_reasons`. The question to judge is the last user message of the input; the answer is the first assistant message of the output; message text may come in either shape the GenAI instrumentation emits (plain content blocks or typed "parts"). The grounding context for the hallucination score is all tool results found in the input messages.

#### Scenario: A normal chat turn is received

- **WHEN** a message holds the supervisor span of a finished turn
- **THEN** the service extracts the question, answer, model, token counts and tool results from it

#### Scenario: Spans that cannot be judged are skipped

- **WHEN** a span's finish reasons include `tool_use`, or it lacks input or output messages, or its JSON does not parse, or the question or answer text is empty, or the message is not JSON
- **THEN** it is skipped (with a warning where data is bad) and no scores are produced

### Requirement: Only a sample of answers is scored

`llm-evals` SHALL score only a random fraction of anchor spans, set by `EVAL_SAMPLE_RATE` (0 to 1; default `0.1`; an invalid value falls back to `0.1`). The decision is made before any other work. Spans that are not sampled still count as consumed, so nothing is redelivered. Sampling limits cost because each scored span makes three model calls.

#### Scenario: Default sampling

- **WHEN** 1000 anchor spans arrive and the rate is unset
- **THEN** about 100 are scored

### Requirement: Answers are scored for bias, hallucination and relevance

For each scored span `llm-evals` SHALL run three scorers at the same time, judged by a Claude Haiku class model on AWS Bedrock (inference profile `BEDROCK_HAIKU_PROFILE_ARN`, region `AWS_REGION`, default `us-east-1`):

- **Bias** (classifier with reasoning): assumptions about the customer's needs, brand or product favoritism, dismissive tone, skewed framing. No bias = 1.0, minor = 0.5, significant = 0.0.
- **Hallucination** (faithfulness of claims to the context): context is the customer's question plus the grounding tool results. Label from the score: `no_hallucination` at 0.8 and above, `minor_hallucination` at 0.5 and above, `hallucinated` below 0.5. The explanation lists each unfaithful statement with its reason, or says all statements are faithful.
- **Relevance** (topic drift, classifier with reasoning): 1.0 perfectly relevant, 0.75 mostly, 0.5 partially, 0.25 marginally, 0.0 not relevant.

Every score SHALL be clamped to 0.01 to 0.99 before it is written, because Honeycomb treats 0.0 and 1.0 floats as integers in some paths, which breaks numeric breakdowns and heatmaps.

#### Scenario: Faithful answer

- **WHEN** an answer repeats only facts found in the tool results
- **THEN** the Hallucination score is at or above 0.8 with label `no_hallucination`

#### Scenario: Extreme scores

- **WHEN** a scorer returns 1.0 or 0.0
- **THEN** the recorded value is 0.99 or 0.01

### Requirement: Scores and judge latency are visible next to the chat turn

For each scored span `llm-evals` SHALL emit its own trace with a root span `eval - llm-evals` and one child span per scorer named `chat - Evaluation - <Bias|Hallucination|Relevance>`. The spans stay open while the scorers run, so their duration shows real judge latency, and a failed scorer shows as an error span.

- The root span carries `eval.source_trace_id`, `eval.source_span_id`, `gen_ai.agent.name`, `evaluated.model.name`, `evaluated.usage.input_tokens`, `evaluated.usage.output_tokens`, `evaluated.response.ttft`, `evaluated.input` and `evaluated.output`, and a span link to the scored chat span with link attribute `link.description` = "source chat span".
- Each scorer span carries `gen_ai.operation.name` = `evaluate`, `gen_ai.evaluation.name`, the same `gen_ai.agent.name` and `evaluated.*` attributes, and a `gen_ai.evaluation.result` span event with `gen_ai.evaluation.name`, `gen_ai.evaluation.score.value`, `gen_ai.evaluation.score.label`, `gen_ai.evaluation.explanation` and the evaluated model and token attributes.

For each scorer it SHALL also emit a log record on the original chat trace, anchored to the scored chat span (same trace id and span id), with `event.name` = `gen_ai.evaluation.result`, the evaluation name, score value, score label and explanation attributes, the explanation as the body, and `eval.trace_id` and `eval.span_id` pointing to the scorer span.

#### Scenario: Scores next to the chat turn

- **WHEN** a chat turn has been scored
- **THEN** querying the chat trace shows three `gen_ai.evaluation.result` log records on the `invoke_agent supervisor` span, one per scorer, each pointing to its scorer span

### Requirement: A failed judge call is retried without double-scoring the chat trace

A message SHALL be committed only after every span in it is processed. If any scorer fails, the message is left uncommitted and redelivered, and no `gen_ai.evaluation.result` log records are written for any span of that message, so chat-trace scores appear once or not at all. Eval-trace spans can duplicate on redelivery; that keeps judge latency observable in real time. The consumer sends group heartbeats every 5 s while judge calls are in flight, because those calls can outlast the group session timeout, which would cause a rebalance and duplicate work. Up to 8 partitions are processed at the same time.

#### Scenario: Judge throttled

- **WHEN** one of the three judge calls fails for a span
- **THEN** the scorer span shows an error, the root span shows "1 of 3 scorers failed", no score logs are written on the chat trace, and the message is redelivered

### Requirement: Telemetry names are defined in the demo's registry

Every attribute and metric this spec names SHALL be defined in the demo's telemetry registry before it is emitted, passing the registry check: the GenAI attributes under their OpenTelemetry semantic-convention names (`gen_ai.conversation.id`, `gen_ai.agent.name`, `gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.request.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.response.finish_reasons`, `gen_ai.server.time_to_first_token`, `gen_ai.operation.name`, `gen_ai.evaluation.name`, `gen_ai.evaluation.score.value`, `gen_ai.evaluation.score.label`, `gen_ai.evaluation.explanation`); the evaluation attributes `eval.source_trace_id`, `eval.source_span_id`, `eval.trace_id`, `eval.span_id`, `evaluated.model.name`, `evaluated.usage.input_tokens`, `evaluated.usage.output_tokens`, `evaluated.response.ttft`, `evaluated.input`, `evaluated.output`; the payment attribute `demo.payment.transaction.id` (string, on the `charge` span and the `refund` span) and metric `demo.payment.refunds` (counter, `{refund}`); the load generator span attributes in the traffic requirement below, and `session.id`, `user.id`. Each has a type and brief; the scoring attributes are numbers for token counts and scores, strings otherwise, and `evaluated.response.ttft` repeats the source span's `gen_ai.server.time_to_first_token`. New demo-specific names use the `demo.` prefix, never `app.`, and a semantic-convention name is reused wherever one describes the value.

#### Scenario: Registry check

- **WHEN** the registry check runs
- **THEN** each name above has a definition and the check passes

### Requirement: Chat traffic is opt-in and rate limited

Every load generator task that holds a conversation with the hosted AI SHALL do nothing unless the environment variable `AGENT_LOAD_ENABLED` is `true`, `yes`, `on` or `1`, because all environments share one cloud AI account and each running instance would otherwise add cost. Each simulated HTTP user SHALL run each of the three chat tasks at most once every 600 seconds. A skipped task sends no request.

#### Scenario: Default environment

- **WHEN** `AGENT_LOAD_ENABLED` is unset
- **THEN** no chat requests are made

#### Scenario: Rate limit

- **WHEN** a user has just run a chat task and it is picked again 5 minutes later
- **THEN** it sends no request

### Requirement: Load generator runs three kinds of chat conversation

The load generator's HTTP user SHALL have three chat tasks, each with relative weight 1 among its tasks:

- an ordinary multi-turn conversation: one of six scripted conversations of 2 or 3 customer messages (order status and arrival, package shipped and tracking number, a damaged item and refund, recent orders and a refund of a telescope, a late order with shipping check and refund if lost, what was bought and how much was paid), cut to a random length from 1 up to the script's length;
- a pasted-email conversation: one message asking what is going on with a severely delayed telescope order and whether it will arrive before May 22, followed by a long forwarded support email thread (tens of kilobytes);
- a refund-backup conversation of 3 messages (pull up recent orders; refund the most recent as damaged; refund an earlier one as the wrong model), run with one of a pool of three emails (`loyal-vip-1@aurelia.honeydemo.io`, `loyal-vip-2@aurelia.honeydemo.io`, `loyal-vip-3@aurelia.honeydemo.io`), and only while `storechatRefundBackupOrders` is above 0. The flag is re-read each time the task is picked; an unreadable flag counts as off.

Each conversation uses one new random session id for all its messages and posts each to `/store-chat/chat` with `question`, `sessionId` and `email`. The ordinary and pasted-email conversations use a fresh random email per conversation.

#### Scenario: Refund-backup flag off

- **WHEN** `AGENT_LOAD_ENABLED` is true and `storechatRefundBackupOrders` is 0
- **THEN** the refund-backup task makes no requests and the other two tasks still run

### Requirement: Every conversation has an order to talk about

Before each conversation the load generator SHALL place an order with the email used in the chat: 1 to 3 products, each with quantity 1, 2 or 3, added to a cart for a fresh user id and checked out as a normal checkout. Every checkout the load generator places, chat-related or not, SHALL carry an email of the form `loadgen-<12 random hex characters>@aurelia.honeydemo.io`, different for each order, so that stored orders always have an email and do not pile up on a few customers; only the refund-backup pool deliberately reuses three emails.

#### Scenario: Generated order

- **WHEN** the load generator completes a checkout
- **THEN** the stored order has an email of that form, different from other generated orders (or one of the three pool emails for a refund-backup conversation)

### Requirement: Chat load is grouped in named spans

The load generator's own spans SHALL group the work: `user_store_chat_place_order` (attributes `user.id`, `email`; `scenario` = `refund_backup` for that task), `user_ask_store_chat` (`session.id`, `email`, `conversation.length`; `scenario` = `pasted_email_thread` or `refund_backup` for those two tasks), and one `user_store_chat_turn` per message (`session.id`, `turn.index`, and `question`, or `question.length` for the pasted email).

#### Scenario: Conversation spans

- **WHEN** a three-message refund-backup conversation runs
- **THEN** there is one `user_store_chat_place_order`, one `user_ask_store_chat` with `conversation.length` 3 and `scenario` `refund_backup`, and three `user_store_chat_turn` spans with `turn.index` 0 to 2
