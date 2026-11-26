# Cart N+1 Queries Specification

## Purpose

This use case gives people and agents using Honeycomb a database anti-pattern to find in trace data: the N+1 query
problem. When the flag `cartservice.add-db-call` is on, loading a cart makes one database call per item instead of
one call for all items, and large carts get slow. An investigator who sees slow cart retrieval or slow checkouts
opens a trace and finds a waterfall of many identical, sequential `SELECT` client spans under the cart's `GetCart`
span, then confirms it by comparing `GetCart` latency with the number of distinct products in the cart. A flag rule
can limit the slow behavior to big carts or to particular shoppers. The cart service has no real database, so the
database calls are simulated spans.

## Apps affected

- `cart`: evaluates the flag on each `GetCart`, produces the simulated database spans and the delay, sets cart size attributes, and records the retrieval latency metric.
- `flagd`: carries the flag `cartservice.add-db-call`.
- `frontend`: reads the cart back after each add and logs cart size attributes.
- `checkout`: reads the cart when it places an order.
- `load-generator`: produces traffic that builds carts of several distinct products.
- `telemetry-schema`: defines the attributes and the metric used here.

## Requirements

### Requirement: The flag `cartservice.add-db-call` switches carts between one batched query and one query per item

The demo SHALL define a boolean flag `cartservice.add-db-call`, state `ENABLED`, description "Add database call to
the cart service", with variants `on` = true and `off` = false and default variant `off`. The shipped flag has no
targeting rules. The cart service SHALL evaluate it on each `GetCart` call, with `false` as the value if it cannot
be read.

#### Scenario: Default

- **WHEN** the flag is `off`
- **THEN** `GetCart` makes the one batched query described below

### Requirement: Flag rules can target big carts or particular shoppers

Before it evaluates the flag, the cart service SHALL set the evaluation context to the key
`cart.unique_items.count` (int, the number of distinct products in the cart) and the key `user.id` (string, the
shopper), so flag rules can target big carts or particular users. The context key is `cart.unique_items.count`,
without the `demo.` prefix.

#### Scenario: Rule on cart size

- **WHEN** a rule turns the flag `on` only when `cart.unique_items.count` is greater than a given number
- **THEN** only the `GetCart` calls for carts with more distinct products than that follow the N+1 behavior

#### Scenario: Rule on user

- **WHEN** a rule turns the flag `on` for one `user.id`
- **THEN** only that shopper's `GetCart` calls follow the N+1 behavior

### Requirement: Flag off gives one batched query

When the flag is `off`, `GetCart` SHALL produce exactly one simulated database span, of kind CLIENT, named
`SELECT * FROM products WHERE id = @id`, with `db.statement` = `SELECT * FROM products WHERE id IN @ids` and
`db.type` = `sql`. It SHALL be a child of the `GetCart` span and carry no `demo.product.id`.

#### Scenario: Cart with five products, flag off

- **WHEN** a five-product cart is loaded
- **THEN** the trace has one such span

### Requirement: Flag on gives one query per distinct item

When the flag is `on`, `GetCart` SHALL produce, one after the other, one simulated database span of kind CLIENT per
distinct cart item, each named `SELECT * FROM products WHERE id = @id`, with `demo.product.id` set to that item's
product id, `db.statement` = `SELECT * FROM products WHERE id = @id` and `db.type` = `sql`. A cart with no items
produces none.

#### Scenario: Cart with three products, flag on

- **WHEN** a three-product cart is loaded
- **THEN** the trace has three sequential query spans, one per product id, and no added delay

### Requirement: Large carts get slow when the flag is on

When the flag is `on` and the cart has more than 6 distinct items, each per-item query SHALL wait a random 100 to 300
milliseconds. The wait SHALL fall inside that query's span, so each span's duration shows it and `GetCart` latency
grows with cart size.

#### Scenario: Cart with eight products, flag on

- **WHEN** an eight-product cart is loaded
- **THEN** the trace has eight sequential query spans of 100 to 300 ms each, and `GetCart` takes at least 0.8 seconds

#### Scenario: Cart with six products, flag on

- **WHEN** a six-product cart is loaded
- **THEN** the trace has six query spans and no added delay

### Requirement: Query spans reach Honeycomb under the instrumentation scope `Database`

The simulated database spans SHALL be exported with the instrumentation scope `Database`.

#### Scenario: Flag on

- **WHEN** the flag is `on` and a cart is loaded
- **THEN** the query spans reach Honeycomb with instrumentation scope `Database`

### Requirement: GetCart spans carry the cart size

Each successful `GetCart` span SHALL carry `demo.cart.unique_items.count`, the number of distinct products in the
cart, and `demo.cart.items.count`, the total quantity of all items in the cart.

#### Scenario: Cart size by span

- **WHEN** a user charts `demo.cart.unique_items.count` on cart service spans
- **THEN** it shows the distribution of distinct products per cart, and a cart with 4 distinct products has the value 4

#### Scenario: Quantity

- **WHEN** a cart holds 3 distinct products with 5 units in total
- **THEN** the `GetCart` span has `demo.cart.unique_items.count` = 3 and `demo.cart.items.count` = 5

### Requirement: Cart retrieval latency is recorded in a histogram

The cart service SHALL record the latency of each cart retrieval in the histogram metric `demo.cart.get_cart.latency`,
unit `s`, with bucket boundaries from 5 ms to 10 s.

#### Scenario: Slow carts

- **WHEN** the flag is `on` and carts of more than 6 distinct products are loaded
- **THEN** the upper buckets of `demo.cart.get_cart.latency` fill

### Requirement: The frontend reads the cart back and logs its size

After the frontend's add-to-cart route has added an item, it SHALL read the cart from the cart service and return
it, so each add triggers a `GetCart`. After a successful request, the cart API route SHALL log one info record
correlated to the active trace. `user.id` is the shopper id from the request: the `sessionId` query parameter on
`GET`, and the `userId` body field on `POST`.

| Method | Message | Attributes |
| --- | --- | --- |
| `GET` | `Cart retrieved successfully` | `user.id`, `demo.cart.items.count` (distinct lines), `demo.cart.total_quantity`, `demo.user_context.selected_currency` |
| `POST` | `Item added to cart successfully` | `user.id`, `demo.product.id`, `demo.cart.quantity_added`, `demo.cart.items.count` (distinct lines in the cart after the add) |

#### Scenario: Add to cart

- **WHEN** a shopper adds a product to a cart that then holds 7 distinct lines
- **THEN** the cart service runs `GetCart` for that shopper, and the frontend logs `Item added to cart successfully` with `demo.cart.items.count` = 7

### Requirement: Large carts also slow checkout while the flag is on

When checkout places an order it SHALL read the shopper's cart from the cart service with `GetCart`, so large carts
also slow down checkout while the flag is `on`.

#### Scenario: Checkout with a large cart

- **WHEN** the flag is `on` and a shopper with 8 distinct products places an order
- **THEN** the checkout trace holds a `GetCart` with eight query spans

### Requirement: Cart telemetry names are defined in the registry

Every custom attribute and metric in this use case SHALL be defined in the demo's telemetry registry before it is
used, under the prefix `demo.` (never `app.`), except `user.id`, for which the semantic convention name is used. The
registry SHALL define these attributes, with these meanings and types:

| Attribute | Type | Meaning |
| --- | --- | --- |
| `user.id` | string | shopper id (semantic convention) |
| `demo.cart.unique_items.count` | int | number of distinct products in the cart, ignoring quantity; set on cart service `GetCart` spans |
| `demo.cart.items.count` | int | cart size: on cart service `GetCart` spans the total quantity of all items; in frontend cart logs the number of distinct lines; on the load generator's multi-item checkout span the number of add-to-cart tasks it ran |
| `demo.cart.total_quantity` | int | sum of the quantity of every item in the cart; set on frontend cart logs |
| `demo.cart.quantity_added` | int | quantity a successful add-to-cart request added |
| `demo.product.id` | string | product the request concerns; set on the per-item query spans |
| `demo.user_context.selected_currency` | string | currency the shopper selected |

The cart service SHALL declare `user.id`, `demo.product.id`, `demo.cart.items.count` and
`demo.cart.unique_items.count`. The frontend SHALL declare `demo.cart.items.count`, `demo.cart.total_quantity`,
`demo.cart.quantity_added`, `demo.product.id`, `demo.user_context.selected_currency` and `user.id`. The registry
SHALL define the metric `demo.cart.get_cart.latency` with the cart service as its emitter.

#### Scenario: Registry check

- **WHEN** the registry check runs
- **THEN** every attribute and metric above resolves with its type

#### Scenario: New attribute

- **WHEN** a change emits an attribute that is not in the registry
- **THEN** the registry check fails

### Requirement: Load generator traffic builds big carts

The load generator SHALL run these cart-related tasks for its HTTP user, with these relative weights: view cart 3; add
to cart 2; single-item checkout 1; multi-item checkout 1. An add-to-cart task SHALL add between 1 and 5 products
(random from its list of ten product ids, each with a random quantity from 1, 2, 3, 4, 5, 10) to the same cart for
one user id, reading the product first and then posting the add to the frontend's cart route. A single-item
checkout SHALL run one add-to-cart task and a multi-item checkout 2 to 4 for the same user id, then place the order
through the frontend's checkout route with that user id, so the multi-item checkout can build a cart of more than 6
distinct products. The multi-item checkout's span SHALL carry `user.id` and `demo.cart.items.count` = the number
of add-to-cart tasks it ran. When browser traffic is enabled, the browser user SHALL also open the cart page and add
a product to the cart through the page.

Outbound requests SHALL carry baggage with `session.id` and `synthetic_request=true` but no trace context, so the
backend starts a new root trace for each request.

#### Scenario: Flag on under load

- **WHEN** `cartservice.add-db-call` is `on` and the load generator runs multi-item checkouts
- **THEN** carts with more than 6 distinct products produce `GetCart` calls with per-item query spans and a visible delay

#### Scenario: Baseline

- **WHEN** the load generator runs with default settings
- **THEN** view cart, add to cart and both checkouts appear in the stated proportions
