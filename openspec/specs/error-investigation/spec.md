# Error Investigation Specification

## Purpose

The demo gives people who use Honeycomb real errors to investigate. A presenter or engineer starts from a failing cart call, a 404 on a product, a missing recommendation or a slow checkout, and finds the cause from wide, trace-correlated logs and span attributes: who the shopper was, which product and cart were involved, which store the cart service used, which session and trace the call belonged to, and which browser sent it. This holds for three sources of errors:

- the `cartFailure` flag, which sends `EmptyCart` to a cart store that cannot be reached, so a failure can be traced to the flag from the logs alone;
- one known troublesome customer, `cust642adf325`, who is played by an on-demand script and generates 404s, failed carts and error logs that can be isolated by user id;
- Kafka trouble at checkout, where the order still succeeds and the problem shows up as a warning log, a failed publish span and a duration.

Every frontend API route for cart, product and recommendations writes one structured info log per outcome with business attributes, and a failure also writes an error log and a classified info record. All of these logs are correlated to the active trace.

## Apps affected

- `cart`: evaluates `cartFailure`, chooses the cart store, logs successes and failures with the shopper, and sets span attributes.
- `flagd`: carries the flag `cartFailure`.
- `frontend`: its cart, product and recommendations API routes log each outcome with business attributes.
- `recommendation`: serves the recommendations that the frontend route logs.
- `checkout`: calls `EmptyCart` after an order; publishes the order event to Kafka; survives and reports Kafka problems.
- `kafka`: the broker that receives order events (address in the `KAFKA_ADDR` environment variable of `checkout`).
- `load-generator`: standard cart and checkout traffic that reaches `EmptyCart`, and the separate on-demand error customer script.
- `telemetry-schema`: defines the attributes used here.

## Requirements

### Requirement: Cart failures can be switched on with flag `cartFailure`

The demo SHALL define a numeric flag `cartFailure`, state `ENABLED`, description "Fail cart service n% of the time", default variant `off`. Its variants SHALL be `off` = 0, `10%` = 0.1, `25%` = 0.25, `50%` = 0.5, `75%` = 0.75, `90%` = 0.9 and `100%` = 1. The value is the probability that an `EmptyCart` call uses the bad store.

#### Scenario: Fresh deployment

- **WHEN** the demo starts with the shipped flag file
- **THEN** `cartFailure` is `off` and no cart call fails because of it

### Requirement: Emptying the cart fails with the flag's probability

The cart service SHALL evaluate `cartFailure` on every `EmptyCart` call, with a default of 0. When the value is above 0 and a random draw in [0, 1) is below it, the service SHALL empty the cart through a bad store, a cart store pointed at an address that cannot be reached, instead of the normal store. Every operation on the bad store fails with an RPC error of status `FailedPrecondition` and a message starting `Can't access cart storage.`. When the value is 0 or the draw is not below it, the normal store is used. A call whose flag value cannot be read behaves as value 0.

#### Scenario: Flag at 100%

- **WHEN** `cartFailure` is `100%` and a cart is emptied
- **THEN** the call fails with `FailedPrecondition` and `Can't access cart storage.`

#### Scenario: Flag at 25%

- **WHEN** `cartFailure` is `25%` and many carts are emptied
- **THEN** about one in four `EmptyCart` calls fails and the others succeed

### Requirement: The flag's effect is announced in the logs

When `cartFailure` selects the bad store for `EmptyCart`, the cart service SHALL log an info record `Using bad cart store due to cartFailure feature flag for user <user.id>`, with the shopper as `user.id`. This record exists so that an investigator can tell the flag, not a real outage, chose the broken store.

#### Scenario: Bad store choice is announced

- **WHEN** `cartFailure` is `100%` and a cart is emptied
- **THEN** that info log appears with the shopper

### Requirement: Orders succeed when the cart cannot be emptied

After checkout has placed an order it SHALL call the cart service's `EmptyCart` for the shopper. If that call fails, checkout SHALL still return the order as successful.

#### Scenario: Cart empty fails after an order

- **WHEN** `cartFailure` is `100%` and a shopper places an order
- **THEN** the order succeeds, and the cart service shows a failed `EmptyCart` span for that shopper

### Requirement: Cart spans identify the shopper and the operation's inputs

Each cart service `AddItem`, `GetCart` and `EmptyCart` span SHALL carry `user.id`. `AddItem` spans SHALL also carry `demo.product.id` and `demo.product.quantity`. `GetCart` spans SHALL carry the span event `Fetch cart` and `EmptyCart` spans the event `Empty cart`.

#### Scenario: Adding a product

- **WHEN** a shopper adds 2 of product `OLJCESPC7Z`
- **THEN** the `AddItem` span has `user.id`, `demo.product.id` = `OLJCESPC7Z` and `demo.product.quantity` = 2

### Requirement: Successful cart operations are logged with the shopper

The cart service SHALL log at information level, with the shopper as `user.id`:

- on `AddItem`: product id and quantity added;
- on `GetCart`: the number of distinct items and the total quantity, for example `Cart retrieved for user <user.id> with 3 unique items, 5 total items`;
- on `EmptyCart`: the `cartFailure` value that was evaluated, as `Cart emptied for user <user.id>, cartFailure rate: <value>`;
- in the cart store, when a cart is not found: that a new cart is being created (on add), or that the cart is not in the cache (on get, which returns an empty cart).

#### Scenario: Shopper views the cart

- **WHEN** a shopper with 3 distinct items (5 units) calls `GetCart`
- **THEN** one info log says the cart was retrieved with 3 unique items and 5 total items, with `user.id`

### Requirement: A failed cart call leaves an error span, an error log and three context records

When `AddItem`, `GetCart` or `EmptyCart` fails with an RPC error, the cart service SHALL set the span's error status with the exception recorded, log one error record naming the user and the error message, then log three info records, and then rethrow the original error to the caller:

| Operation | Error record | Info record 1 |
| --- | --- | --- |
| `AddItem` | `Failed to add product <product> to cart for user <user.id>: <message>` | `Cart operation failure context`: user, product, quantity, request time |
| `GetCart` | `Failed to retrieve cart for user <user.id>: <message>` | `Cart retrieval failure context`: user, request time |
| `EmptyCart` | `Failed to empty cart for user <user.id>: <message>` | `Cart empty failure context`: user, the `cartFailure` value, request time |

Info record 2 (all operations) SHALL give the session id, read from the `session.id` baggage entry of the request, and the trace id: `Cart failure environment - Session: <id>, TraceId: <trace id>`. Info record 3 SHALL give the type name of the cart store in use and the caller's `User-Agent` header; for `EmptyCart` it gives the primary and the bad store type names and the `User-Agent` (`Store types - Primary: ..., Bad: ..., User-Agent: ...`). These records are deliberately verbose, as wide-event context for the investigation. The same records are written when the real store fails, so a real outage is investigated the same way.

#### Scenario: cartFailure is on and the store fails

- **WHEN** `cartFailure` makes `EmptyCart` use the bad store and the call fails
- **THEN** the trace has an error span with the exception, an error log, and three info context logs with the `cartFailure` value, session id, trace id, store types and user agent

#### Scenario: Real store outage

- **WHEN** the normal cart store is unreachable and `GetCart` fails
- **THEN** the same error log and three context logs are written, without a `Using bad cart store` log

### Requirement: Session identity reaches the cart service

Callers SHALL send the shopper's session id in the W3C baggage entry `session.id`, so the cart service can log it. The browser, the load generator and the error customer all send this baggage on their requests.

#### Scenario: Browser add to cart

- **WHEN** a browser session adds to the cart and the call fails
- **THEN** the failure context log holds the session id of that browser tab

### Requirement: Cart API routes log every outcome with cart attributes

After a successful request, the frontend's cart API route SHALL log one info record correlated to the active trace. `user.id` is the shopper id from the request: the `sessionId` query parameter on `GET`, and the `userId` body field on `POST` and `DELETE`.

| Method | Message | Attributes |
| --- | --- | --- |
| `GET` | `Cart retrieved successfully` | `user.id`, `demo.cart.items.count` (distinct lines), `demo.cart.total_quantity`, `demo.user_context.selected_currency` |
| `POST` | `Item added to cart successfully` | `user.id`, `demo.product.id`, `demo.cart.quantity_added`, `demo.cart.items.count` (distinct lines in the cart after the add) |
| `DELETE` | `Cart emptied successfully` | `user.id`, `demo.cart.action` = `empty` |

When the cart service call fails, the route SHALL log one error record with the exception, log one info record that sets `error.type`, then rethrow so the HTTP response is an error:

| Method | Error record message | Info record message | `error.type` |
| --- | --- | --- | --- |
| `GET` | `Failed to retrieve cart` | `Cart retrieval failed - unable to load user cart` | `cart_retrieval_failed` |
| `POST` | `Failed to add item to cart` | `Cart add operation failed - unable to add item to user cart` | `cart_add_failed` |
| `DELETE` | `Failed to empty cart` | `Cart empty operation failed - unable to clear user cart` | `cart_empty_failed` |

The error and info records on `GET` carry `user.id` and `demo.user_context.selected_currency`. On `POST` they carry `user.id`, `demo.product.id` and `demo.cart.quantity_requested`, the quantity asked for. On `DELETE` they carry `user.id`.

#### Scenario: Add to cart

- **WHEN** a shopper adds two telescopes
- **THEN** an info log `Item added to cart successfully` exists with `demo.product.id` and `demo.cart.quantity_added` = 2

#### Scenario: Empty cart fails

- **WHEN** the shopper empties the cart and the cart service fails the call
- **THEN** the frontend logs `Failed to empty cart` and an info log with `error.type` = `cart_empty_failed`, and the HTTP response is an error

### Requirement: Product API route logs every outcome with product attributes

After a successful `GET` of a product by id, the frontend SHALL log one info record `Product retrieved successfully`, correlated to the active trace, with `user.id`, `demo.product.id`, `demo.product.name`, `demo.product.price` and `demo.user_context.selected_currency`. `user.id` is the value of the request's `session-id` header. `demo.product.price` is the whole price in US dollars, whole units plus fraction, as a decimal number.

When the product lookup fails, the route SHALL log an error record `Failed to retrieve product` with the exception, `user.id`, `demo.product.id` and `demo.user_context.selected_currency`; then an info record `Product lookup failed - invalid product ID requested` with the same attributes and `error.type` = `product_not_found`; then rethrow so the HTTP response is an error.

#### Scenario: Unknown product id

- **WHEN** a client requests a product id that does not exist
- **THEN** an error log and an info log with `error.type` = `product_not_found` and the requested `demo.product.id` exist, and the response is an error

#### Scenario: Product priced 349.95

- **WHEN** the frontend logs a product whose price is 349 units and 0.95 fraction
- **THEN** `demo.product.price` is 349.95

#### Scenario: Product priced 19.99

- **WHEN** the frontend logs a product whose price is 19 units and 0.99 fraction
- **THEN** `demo.product.price` is 19.99, and a whole-dollar product logs its whole-dollar value

### Requirement: Recommendations API route logs every outcome with recommendation attributes

After a successful `GET` of recommendations, the frontend SHALL log one info record `Recommendations retrieved successfully`, correlated to the active trace, with `user.id` (the `sessionId` query parameter), `demo.recommendations.input_product_count` (how many product ids the request sent to the recommendation service, 1 if only one was sent), `demo.product.recommended.count` (how many recommended products were returned), `demo.recommendations.product_ids` (the first four product ids the recommendation service returned) and `demo.user_context.selected_currency`. At most four recommended products are returned.

When the call fails, the route SHALL log an error record `Failed to retrieve recommendations` with the exception, `user.id`, `demo.recommendations.input_product_count` and `demo.user_context.selected_currency`; then an info record `Recommendations retrieval failed - unable to get product suggestions` with the same attributes and `error.type` = `recommendations_failed`; then rethrow so the HTTP response is an error.

#### Scenario: Successful recommendations

- **WHEN** a shopper opens a product page and the frontend asks for recommendations for one product id
- **THEN** an info log exists with `demo.recommendations.input_product_count` = 1, `demo.product.recommended.count` of at most 4, and up to four ids in `demo.recommendations.product_ids`

#### Scenario: Recommendation service fails

- **WHEN** the recommendation call fails
- **THEN** an error log and an info log with `error.type` = `recommendations_failed` exist, and the HTTP response is an error

### Requirement: Attribute contract for these logs

The telemetry registry SHALL define these attributes, with these meanings and types:

| Attribute | Type | Meaning |
| --- | --- | --- |
| `user.id` | string | shopper id (semantic convention) |
| `demo.product.id` | string | product the request concerns |
| `demo.product.name` | string | product name |
| `demo.product.price` | double | price of the product in US dollars (examples 19.99, 349.95) |
| `demo.product.quantity` | int | quantity of a product being added to the cart or ordered |
| `demo.product.recommended.count` | int | number of recommended products returned |
| `demo.recommendations.input_product_count` | int | how many product ids the frontend sent to the recommendation service (1 if only one was sent) |
| `demo.recommendations.product_ids` | string[] | the first four product ids the recommendation service returned |
| `demo.cart.items.count` | int | number of distinct lines in the cart, as logged by the frontend |
| `demo.cart.total_quantity` | int | sum of the quantity of every item in the cart |
| `demo.cart.quantity_added` | int | quantity a successful add-to-cart request added |
| `demo.cart.quantity_requested` | int | quantity an add-to-cart request asked for, recorded on failures too |
| `demo.cart.action` | string | cart operation the frontend API request performed (example: `empty`) |
| `demo.user_context.selected_currency` | string | currency the shopper selected |
| `error.type` | string | failure class on logs (semantic convention) |
| `messaging.kafka.producer.success` | bool | whether the order event publish was confirmed |
| `messaging.kafka.producer.duration_ms` | int | milliseconds from hand-off to the producer until its outcome |

The `cart` service SHALL declare `user.id`, `demo.product.id` and `demo.product.quantity`. The `frontend` service SHALL declare `user.id`, `demo.product.id`, `demo.product.name`, `demo.product.price`, `demo.product.recommended.count`, `demo.recommendations.input_product_count`, `demo.recommendations.product_ids`, `demo.cart.items.count`, `demo.cart.total_quantity`, `demo.cart.quantity_added`, `demo.cart.quantity_requested`, `demo.cart.action`, `demo.user_context.selected_currency` and `error.type`. The `checkout` service SHALL declare `messaging.kafka.producer.success` and `messaging.kafka.producer.duration_ms`.

#### Scenario: Registry check

- **WHEN** the registry check runs
- **THEN** every attribute above resolves with its type, and the emitting services declare them

### Requirement: Telemetry names are registered under `demo.`

Every custom attribute and metric named in this use case SHALL be defined in the demo's telemetry registry before it is used in code. Custom names SHALL use the prefix `demo.` and never `app.`. Where an OpenTelemetry semantic convention name exists (`user.id`, `error.type`, `session.id`, `messaging.*`, `peer.service`, `network.transport`), it SHALL be used instead of a demo name. The Kafka producer attributes keep exactly the names `messaging.kafka.producer.success` and `messaging.kafka.producer.duration_ms`. Baggage keys (`session.id`, `synthetic_request`, `customer.id`, `customer.type`) are baggage entries, not registry attributes.

#### Scenario: New attribute

- **WHEN** a change emits an attribute that is not in the registry
- **THEN** the registry check fails

### Requirement: Standard traffic reaches the cart operations

The load generator SHALL run these cart-related tasks for its HTTP user, with these relative weights: view cart 3; add to cart 2; single-item checkout 1; multi-item checkout 1. An add-to-cart task SHALL add between 1 and 5 products (random from the product ids it knows, each with a random quantity from 1, 2, 3, 4, 5, 10) to the same cart for one user id, reading the product first and then posting the add to the frontend's cart route. A single-item checkout SHALL run one add-to-cart task and a multi-item checkout 2 to 4 for the same user id, then place the order through the frontend's checkout route with that user id, so checkout calls `EmptyCart` for that user. The multi-item checkout's span SHALL carry `user.id` and `demo.cart.items.count` = the number of add-to-cart tasks it ran. When browser traffic is enabled, the browser user SHALL also open the cart page and add a product to the cart through the page.

Outbound requests SHALL carry baggage with `session.id` and `synthetic_request=true` but no trace context, so the backend starts a new root trace for each request.

#### Scenario: Checkout under cartFailure

- **WHEN** `cartFailure` is on and the load generator runs checkouts
- **THEN** each checkout is followed by an `EmptyCart` call that fails with the flag's probability, with the verbose failure logs

#### Scenario: Baseline

- **WHEN** the load generator runs with default settings
- **THEN** view cart, add to cart and both checkouts appear in the stated proportions

### Requirement: One known customer generates errors on demand

The demo SHALL include an error customer: a Locust script of its own that a person starts on purpose, separate from the standard load generator, so that a presenter can show how to find one customer's traffic in Honeycomb. It SHALL run one kind of user whose user id is always `cust642adf325`, with a wait of 1 to 5 seconds between tasks. By default it SHALL target a frontend at `http://localhost:9191`; the target is changed by editing the script's host setting. At start it SHALL log the warning "Time to generate some errors!". The standard load generator SHALL NOT start it and no standard request carries the user id `cust642adf325`.

#### Scenario: Standard traffic stays clean

- **WHEN** the standard load generator runs
- **THEN** no request carries the user id `cust642adf325`

#### Scenario: Finding the customer

- **WHEN** the error customer script runs
- **THEN** all its traffic can be grouped by the user id `cust642adf325`

### Requirement: The error customer identifies itself in baggage

Each error customer session SHALL attach baggage with a fresh `session.id`, `synthetic_request=true`, `customer.id` = `cust642adf325` and `customer.type` = `error_generator`, and then load the homepage (`GET /`).

#### Scenario: Baggage

- **WHEN** the error customer starts a session
- **THEN** its requests carry the four baggage entries and the first request is `GET /`

### Requirement: The error customer fails on purpose

The error customer SHALL run these tasks, with these relative weights:

| Task | Weight | Behavior |
| --- | --- | --- |
| Add a nonexistent product to the cart, then read the cart | 3 | `POST /api/cart` with a nonexistent product id, quantity 1, 2 or 3 and `userId` = `cust642adf325`; then `GET /api/cart?sessionId=cust642adf325&currencyCode=` |
| Browse a nonexistent product | 2 | `GET /api/products/<id>`, expects 404 |
| Ask for recommendations for a nonexistent product | 2 | `GET /api/recommendations` with `productIds=<id>` |
| Browse a valid product, for contrast | 1 | `GET /api/products/<id>` for a real product id |
| Check out after adding nonexistent products | 1 | add 1 or 2 nonexistent products (quantity 1) to the cart, reading the cart after each add, then `POST /api/checkout` with a random sample person whose `userId` is `cust642adf325` |

The nonexistent product ids SHALL look like real ones. They SHALL be these ten values: `9XYZ123ABC`, `7DEF456GHI`, `5JKL789MNO`, `3PQR012STU`, `1VWX345YZA`, `8BCD678EFG`, `6HIJ901KLM`, `4NOP234QRS`, `2TUV567WXY`, `0ZAB890CDE`. The valid products SHALL be the ten product ids of the demo's catalogue.

#### Scenario: Invalid product

- **WHEN** the script browses a nonexistent product
- **THEN** the frontend answers 404 and logs the `product_not_found` records

### Requirement: Expected errors count as successes in load statistics

In the error customer's load test statistics, an error response (HTTP status 400 or above) to a request that is meant to fail SHALL count as a success, so that Locust statistics stay clean. When the request to browse a nonexistent product returns a success status, the request SHALL count as a failure with the message "Expected 404 but got `<status>`" and an error log SHALL say that this points to a system issue.

#### Scenario: Expected 404

- **WHEN** a nonexistent product returns 404
- **THEN** Locust records a success

#### Scenario: Unexpected success

- **WHEN** a nonexistent product returns 200
- **THEN** Locust records a failure "Expected 404 but got 200"

### Requirement: The error customer's own logs are generous and findable

The error customer SHALL send log records over OTLP under the service name `ecommerce-store-client`. Every record SHALL carry the attribute `user.id` = `cust642adf325`. The script SHALL log excessively on purpose: at each step it logs what it is about to do, the payload or parameters, the response status and body, and that the step is complete, mostly at error level.

#### Scenario: Log search

- **WHEN** the script has run
- **THEN** logs from `ecommerce-store-client` with `user.id` = `cust642adf325` describe each failed step, mostly at error level

### Requirement: Order events go to the order topic

After an order is placed, checkout SHALL publish the order result as one message to the topic named by the `KAFKA_TOPIC` environment variable, defaulting to `orders`, with the trace context of the order injected into the message headers.

#### Scenario: Default topic

- **WHEN** an order completes and `KAFKA_TOPIC` is unset
- **THEN** the order event is published to the topic `orders` and consumers can continue the trace

### Requirement: The publish is visible as a producer span

Checkout SHALL record the publish on a span of kind producer named `<topic> publish` (for example `orders publish`) with the attributes `peer.service` = `kafka`, `network.transport` = `tcp`, `messaging.system` = `kafka`, `messaging.destination.name` = the topic, `messaging.operation` = `publish`, and `messaging.kafka.destination.partition`.

#### Scenario: Span shape

- **WHEN** an order event is published to `orders`
- **THEN** a producer span `orders publish` exists with `messaging.system` = `kafka` and `messaging.destination.name` = `orders`

### Requirement: Orders succeed and warn when Kafka was never reachable

If `KAFKA_ADDR` is set but the producer could not be created at startup (for example Kafka was down), `PlaceOrder` SHALL still complete successfully, skip publishing, and emit one warning log, correlated to the trace, with the message `skipping post-processor: KafkaProducerClient not initialized` and the configured broker address in `kafka.broker`. If `KAFKA_ADDR` is not set, `PlaceOrder` SHALL skip publishing silently.

#### Scenario: Kafka was down at startup

- **WHEN** an order is placed and the producer never initialized
- **THEN** the order succeeds and the trace has the warning log `skipping post-processor: KafkaProducerClient not initialized` with `kafka.broker`

#### Scenario: No Kafka configured

- **WHEN** `KAFKA_ADDR` is unset
- **THEN** the order succeeds and no warning is logged

### Requirement: An unreachable broker fails within seconds

The Kafka producer SHALL use a 15 second timeout for dial, read and write, so an unreachable broker fails promptly.

#### Scenario: Broker unreachable

- **WHEN** the broker address does not answer
- **THEN** the producer gives up within about 15 seconds

### Requirement: The wait for the publish outcome is bounded and recorded

After handing the order event to the producer, checkout SHALL wait at most 15 seconds for the producer to report success or an error. Whatever the outcome, the order response SHALL still be returned and `messaging.kafka.producer.duration_ms` (int, milliseconds from hand-off to outcome) SHALL be set on the publish span.

- On success, `messaging.kafka.producer.success` (bool) is true, the span carries the message offset in `messaging.kafka.message.offset`, and an info log reports the offset and duration.
- On a reported error, `messaging.kafka.producer.success` is false, the span has error status carrying the error text, and an error log `Failed to write message: <error>` is written.
- On timeout, `messaging.kafka.producer.success` is false, the span has error status with the text `No response from frauddetection within 15 seconds`, and an error log with the same text is written.
- If the request context ends before the event is handed over or before the outcome arrives, `messaging.kafka.producer.success` is false and the span has error status that names the cancellation.

#### Scenario: No acknowledgement

- **WHEN** the producer neither confirms nor reports an error
- **THEN** after 15 seconds the publish span shows `messaging.kafka.producer.success` = false, `messaging.kafka.producer.duration_ms` of about 15000 and error status `No response from frauddetection within 15 seconds`, and the order still completes

#### Scenario: Successful publish

- **WHEN** Kafka confirms the message
- **THEN** the publish span has `messaging.kafka.producer.success` = true and a duration, and no error status
