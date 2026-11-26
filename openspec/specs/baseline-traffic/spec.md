# Baseline Traffic Specification

## Purpose

Every investigation in Honeycomb needs a steady, believable background so that a deviation stands out. The load generator produces that baseline for demo operators and for the people and agents who investigate: browsing, recommendations, ads, carts and ordinary checkouts. Its requests reach the backend as fresh root traces, like real edge traffic, and are marked as synthetic so they can be told apart from real users. Optional traffic that costs money, such as conversations with a paid AI service, is off unless an environment asks for it.

## Apps affected

- `load-generator`: produces the baseline traffic with Locust.
- `frontend-proxy`: the load generator's target (`LOCUST_HOST`).

## Requirements

### Requirement: Simulated users arrive at a steady pace

The load generator SHALL run an HTTP user with relative weight `LOCUST_HTTP_USER_WEIGHT` (default 9) that waits a random 1 to 10 seconds between tasks. Each simulated user SHALL have its own `session.id` (a UUID), set once at the start of the user's session and kept for all its requests. Each user session SHALL start by loading the homepage in a span named `user_session_start`.

#### Scenario: Default settings

- **WHEN** the load generator runs with default settings
- **THEN** simulated users each pause 1 to 10 seconds between tasks and every request of one user carries the same `session.id`

### Requirement: Baseline task mix is dominated by browsing

The HTTP user's baseline tasks SHALL have these relative weights: browse a product 10; get recommendations 3; get ads 3; view cart 3; add to cart 2; single-item checkout 1; multi-item checkout 1; homepage 1. Browsing therefore dominates and checkouts are rare but constant. Each task SHALL run inside a span named as in the list below, with the listed attributes.

| Task | Request | Span | Attributes |
| --- | --- | --- | --- |
| Homepage | `GET /` | `user_index` | |
| Browse product | `GET /api/products/<id>` for a random product from the product catalogue ids | `user_browse_product` | `demo.product.id` |
| Recommendations | `GET /api/recommendations` with `productIds=<id>` for a random product | `user_get_recommendations` | `demo.product.id` |
| Ads | `GET /api/data/` with `contextKeys=<category>`, a random category of `binoculars`, `telescopes`, `accessories`, `assembly`, `travel`, `books`, or none | `user_get_ads` | `demo.ad.category` (the category as text) |
| View cart | `GET /api/cart` | `user_view_cart` | |

#### Scenario: Steady baseline

- **WHEN** the load generator runs with default settings
- **THEN** all baseline tasks appear, browsing dominates and checkouts are rare but constant

### Requirement: Add to cart builds realistic carts

A single add-to-cart task SHALL add between 1 and 5 products (the count is random) to one cart for one user id. Each product is random, and each quantity is random from 1, 2, 3, 4, 5, 10. Each add SHALL be its own root trace, and SHALL first `GET /api/products/<id>` and then `POST /api/cart` with `{"item": {"productId", "quantity"}, "userId"}`. Its span SHALL be named `user_add_to_cart` and carry `user.id`, `demo.product.id` and `demo.product.quantity`. When called on its own it uses a fresh user id (a UUID).

#### Scenario: Multi-line cart

- **WHEN** the add-to-cart task runs
- **THEN** the cart for that user id holds 1 to 5 add requests, each with a quantity from the list

### Requirement: Ordinary checkouts come from unique customers

The single-item checkout task SHALL create a fresh user id, run one add-to-cart task for it, then place the order. The multi-item checkout SHALL create a fresh user id, run 2, 3 or 4 add-to-cart tasks for it (chosen at random), then place the order. The spans SHALL be named `user_checkout_single` (attribute `user.id`) and `user_checkout_multi` (attributes `user.id` and `demo.cart.items.count`, the number of add-to-cart tasks).

The order SHALL be placed with `POST /api/checkout`. The body SHALL be a random person from the sample people (name, address and card details), with `userId` set to the shopper's user id and a fresh random `email` of the form `loadgen-<12 hex characters>@aurelia.honeydemo.io` so that orders do not pile up on a few customers.

#### Scenario: Unique customers

- **WHEN** two checkouts run
- **THEN** their orders carry different emails and different user ids

### Requirement: Backend traces start fresh and are marked synthetic

Outbound requests SHALL carry baggage that includes `session.id` and `synthetic_request=true`, but SHALL NOT carry trace context. Each backend service therefore sees a new root trace instead of a continuation of a load generator span, like real edge traffic. The load generator still emits its own spans. The baggage marker `synthetic_request=true` SHALL survive to the backend services, so that backend data can be filtered to exclude synthetic traffic with `demo.synthetic_request`.

#### Scenario: Root trace

- **WHEN** the load generator calls the frontend
- **THEN** the frontend's span has no parent from the load generator, and the request carries `synthetic_request=true` and the user's `session.id` in baggage

### Requirement: Paid AI traffic is opt-in and rate limited

Every load generator task that holds a conversation with a paid, cloud-hosted AI service SHALL do nothing unless the environment variable `AGENT_LOAD_ENABLED` is `true`, `yes`, `on` or `1`. All environments share one cloud AI account, so each running instance would otherwise add cost. Each simulated user SHALL run each such task at most once every 600 seconds. A task that is skipped for either reason sends no request.

#### Scenario: Default environment

- **WHEN** `AGENT_LOAD_ENABLED` is unset
- **THEN** no conversation task sends a request

#### Scenario: Cooldown

- **WHEN** a user has just run a conversation task and the task is picked again 5 minutes later
- **THEN** it sends no request

### Requirement: Telemetry names are defined in the registry

Every attribute the baseline traffic sets on its spans (`session.id`, `user.id`, `demo.product.id`, `demo.product.quantity`, `demo.ad.category`, `demo.cart.items.count`) and the synthetic-request marker `demo.synthetic_request` SHALL be defined in the demo's telemetry registry and declared for the `load-generator` service. Each SHALL use a `demo.` name unless a semantic-convention name exists (`session.id`, `user.id`), and none SHALL start with `app.`.

#### Scenario: Registry check

- **WHEN** the registry check runs
- **THEN** every attribute listed above is defined and declared for the `load-generator` service
