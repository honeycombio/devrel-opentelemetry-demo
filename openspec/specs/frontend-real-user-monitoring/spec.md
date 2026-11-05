# Frontend Real User Monitoring Specification

## Purpose

The storefront shows what Honeycomb Frontend Observability can do with real-user data. People using Honeycomb watch
Core Web Vitals (LCP, CLS, INP) and name the page element behind a bad score. They follow one browser tab as one
session. They see browser clicks, form submits and data fetches linked to the backend trace they caused. They find
a slow checkout, which is slow for one city only, by comparing the browser order span and the checkout `PlaceOrder`
span by city. They also see browser errors that show up as failed spans without a flood of retries. Real-browser
load and a homepage flood keep this data flowing.

The data is only believable if the page works. Icons load behind the proxy, the platform label never shows
`undefined`, and a failed order tells the shopper what happened. The proxy front door names the storefront
`api-gateway` and writes access logs in their own `access-logs` service.

## Apps affected

- `frontend`: browser telemetry (web distribution of OpenTelemetry with Web Vitals), per-tab session, named data-fetch and order spans, stable DOM ids, failed-order message, server-side instrumentation.
- `frontend-proxy`: same-origin OTLP/HTTP route for browser spans, the `api-gateway` cluster, access logs.
- `image-provider`: serves product images through the proxy without buffering.
- `checkout`: delays and annotates `PlaceOrder` for the city "Slowville".
- `load-generator`: real-browser user and homepage flood that drive the data.
- `flagd`: holds the `loadGeneratorFloodHomepage` flag.

## Requirements

### Requirement: Browser spans reach the collector through the page's own origin

The browser SHALL export its traces to `<page origin>/otlp-http/v1/traces`. It MUST NOT need an API key or a
collector address built into the page, so one built image works on every instance (local, EKS, AKS). The service
name of browser spans SHALL be the value the frontend is deployed with for its public service name. The browser
telemetry SHALL be produced by the Honeycomb web distribution of OpenTelemetry, which adds Web Vitals and a
session concept.

#### Scenario: Page load on any instance

- **WHEN** a user opens the storefront at any hostname
- **THEN** browser spans are sent to that same hostname under `/otlp-http/v1/traces` and arrive in Honeycomb under the frontend's browser service name

### Requirement: The proxy forwards browser telemetry to the collector

The `frontend-proxy` SHALL route every request whose path starts with `/otlp-http/` to the collector's OTLP/HTTP
port, with the `/otlp-http/` prefix replaced by `/`. So `/otlp-http/v1/traces` reaches the collector as
`/v1/traces`. The route SHALL NOT retry requests, so a slow collector does not duplicate spans.

#### Scenario: Browser export

- **WHEN** the browser posts to `/otlp-http/v1/traces` on the proxy
- **THEN** the collector receives one `POST /v1/traces` request

### Requirement: The browser instruments loads, requests, clicks and submits

The browser SHALL produce spans for document load, `fetch` and XMLHttpRequest calls, and for user interactions
limited to `click` and `submit` events. It SHALL also report Web Vitals (Core Web Vitals such as LCP, CLS, INP).
Network timing events on document-load, `fetch` and XMLHttpRequest spans SHALL NOT be recorded as span events,
to keep spans small.

#### Scenario: Click on a product

- **WHEN** a user clicks a product card
- **THEN** a click interaction span exists, and the `fetch` spans it caused are its descendants

### Requirement: Browser requests continue the trace on the backend

The browser SHALL send W3C trace context and W3C baggage on every outgoing request, to any URL (the match is
deliberately unrestricted, because the storefront's backend is on the same origin behind a proxy).

#### Scenario: Add to cart

- **WHEN** a user adds a product to the cart
- **THEN** the trace that starts in the browser continues through the frontend server and into the cart service

### Requirement: Browser request spans say whether the traffic is synthetic

Every browser `fetch` span SHALL carry `demo.synthetic_request`, holding the value the page was served with. The
page is served with `"true"` when the request that loaded it carried the baggage entry `synthetic_request=true`.
Real users and the load generator can then be told apart in a query.

#### Scenario: Load generator browser session

- **WHEN** the page is served for a request that carries `synthetic_request=true` in its baggage
- **THEN** its `fetch` spans have `demo.synthetic_request` equal to `"true"`

### Requirement: Telemetry is flushed when the page is hidden

The browser SHALL flush pending telemetry whenever the page's visibility changes to hidden (tab switch,
navigation away, close). Without this, automated browser tests and short synthetic sessions lose their last
spans, and late Web Vitals do not arrive.

#### Scenario: Short synthetic session ends

- **WHEN** a headless browser session finishes and the page becomes hidden
- **THEN** the spans from that session, including Web Vitals, are exported without waiting for the normal batch delay

### Requirement: Server-side traces contain no file, DNS or socket spans

The frontend's Node.js server SHALL NOT produce spans for file system access, DNS lookups or raw network
connections. HTTP, gRPC and framework request spans SHALL remain.

#### Scenario: Server request trace

- **WHEN** a request is served by the frontend server
- **THEN** its trace contains no `fs`, `dns` or `net` spans

### Requirement: One session per browser tab

The browser SHALL create a session (user id, selected currency with default `USD`) on first use in a tab and
keep it for the life of that tab only. A new tab, or a tab opened after closing the old one, SHALL start a new
session with a new user id. The session MUST NOT be shared between tabs or kept for later visits.

#### Scenario: Two tabs

- **WHEN** a user opens the storefront in two tabs
- **THEN** each tab has a different `session.id`

#### Scenario: Reload

- **WHEN** a user reloads the page in a tab
- **THEN** the `session.id` stays the same

### Requirement: Session and user identity are on every browser span and on outgoing baggage

Each browser span SHALL carry `session.id` and `enduser.id`, both equal to the session's user id. Each call the
browser makes to the frontend's API SHALL carry both as baggage entries with the same names and value. The
session SHALL be read each time a span starts and each time baggage is built, not once at page load, so values
that change while the page is open are reflected.

#### Scenario: Server span of a browser request

- **WHEN** the browser calls the frontend API
- **THEN** downstream spans can read `session.id` and `enduser.id` from baggage and match them to the browser spans

#### Scenario: Session changes while the page is open

- **WHEN** the session's fields change in an open tab
- **THEN** spans started afterwards carry the new values without a reload

### Requirement: The browser session is the feature-flag context

The browser's feature flag evaluation context SHALL be set when the page starts. It SHALL use the session user id
as its targeting key and SHALL include the session fields, so flag rules can target a session.

#### Scenario: Targeting by session

- **WHEN** a flag rule targets a session's targeting key
- **THEN** it applies only to that tab's session

### Requirement: Data fetches run inside a named span

The browser SHALL wrap these data fetches in a span, using exactly these span names and tracer names:

| Fetch | Span name | Tracer name |
| --- | --- | --- |
| Ads for the page context | `getAds` | `ad-provider` |
| Recommendations for the selected currency | `selectedCurrency` | `ad-provider` |
| Supported currency list | `getSupportedCurrencyList` | `currency-provider` |

The recommendations span name SHALL stay `selectedCurrency`, because dashboards group by it.

#### Scenario: Currency list loads

- **WHEN** the storefront loads
- **THEN** a `getSupportedCurrencyList` span exists and is the parent of the `fetch` span for the currency request

#### Scenario: Recommendations load

- **WHEN** the recommendations fetch runs
- **THEN** its span is named `selectedCurrency` and its tracer is `ad-provider`

### Requirement: Placing an order runs inside a named span that records the destination

When the shopper submits the checkout form, the browser SHALL wrap the order call in a span named `placeOrder`
with tracer name `cart-provider`. The span SHALL carry these attributes, and the `fetch` span for the order
request and the backend trace SHALL be its descendants:

| Attribute | Type | Meaning |
| --- | --- | --- |
| `rpc.service` | string | `CartService` |
| `rpc.method` | string | `placeOrder` |
| `component` | string | `CartProvider` |
| `demo.user_context.city` | string | city of the shipping address entered in the form; `No city` when empty |
| `demo.user_context.state` | string | state of the shipping address entered in the form; `No state` when empty |

The order call SHALL NOT be retried after failure, so one failed submit produces one error trace.

#### Scenario: Order for another city

- **WHEN** a shopper places an order with city `London` and state `England`
- **THEN** the `placeOrder` span has `demo.user_context.city` = `London` and `demo.user_context.state` = `England`

#### Scenario: Slowville in the browser

- **WHEN** a shopper places an order with city `Slowville`
- **THEN** the `placeOrder` span has `demo.user_context.city` = `Slowville` and lasts 5 to 8 seconds longer than other orders, with the backend trace beneath it

### Requirement: Failures mark the span as an error, never as OK

When a wrapped fetch or the order call fails, its span SHALL have error status and record the failure:

- for an `Error`, as an exception event;
- for a string, as an event named `error` with attribute `error.message`;
- for anything else, as an event named `error` with attribute `error message` (with a space) set to `Unknown error`.

The wrapper SHALL NOT set an OK status on success (it stays unset). It SHALL end the span in every case. The
caller of a failed data fetch SHALL receive a rejection with the text `query failed`.

#### Scenario: Recommendation service is down

- **WHEN** the recommendations call fails
- **THEN** the `selectedCurrency` span has error status and an `error` or `exception` event, and the page still renders without recommendations

#### Scenario: Failure that is neither an Error nor a string

- **WHEN** a wrapped fetch fails with a value of another type
- **THEN** the span has an `error` event whose `error message` attribute is `Unknown error`

### Requirement: Failed queries are not retried

Ads, recommendations and currency queries SHALL NOT be retried after failure. One failing user action produces
one error trace, not several. Ads and recommendations SHALL NOT refetch when the window regains focus.

#### Scenario: Ad service errors

- **WHEN** the ad call fails once
- **THEN** exactly one failed `getAds` span is produced

### Requirement: Queries are treated as stale immediately

The shared query client SHALL treat data as stale at once and refetch on mount and on window focus (except where
the previous requirement turns it off), so repeated navigation produces fresh backend traffic and traces.

#### Scenario: Navigating back to home

- **WHEN** a user returns to a page that showed products
- **THEN** the data is fetched again

### Requirement: Web Vitals name the element that caused them

Core Web Vitals spans (LCP, CLS, INP) report the element that caused the metric as a CSS selector. So that this
selector is short and readable, the storefront SHALL render these elements with exactly these `id` values (`<id>`
is the product id):

| Element | Id |
| --- | --- |
| Home page container | `home` |
| Home outer container | `outer-container` |
| Hot products content block | `hot-products-content` |
| Hot products title | `hot-products` |
| Banner, its image, its title | `banner`, `banner-img`, `banner-title` |
| Header logo image | `brand-img` |
| Selected currency symbol, currency dropdown | `selected-currency`, `currency-select` |
| Platform label | `platform` |
| Product list | `product-list` |
| Product link, card, image (per product) | `product-link-<id>`, `product-card-<id>`, `product-image-<id>` |
| Product details block inside a card | `product-details` |
| Recommendations block | `product-recommendations` |
| Cart page container | `cart` |
| Cart items list | `cart-items` |
| One cart line | `cart-item-<id>` |
| Checkout form | `checkout-form` |
| Empty cart container, title, subtitle, button | `cart-empty`, `cart-empty-title`, `cart-empty-subtitle`, `empty-cart-button` |

Ids on per-product elements SHALL be unique on a page. The data attributes the storefront's browser tests use as
test hooks MUST stay on their elements. The header logo SHALL be a plain image element, so automated browser
tests can wait for it.

#### Scenario: LCP is the banner image

- **WHEN** the home page's largest paint is the banner image
- **THEN** the web-vitals span names the element by a selector containing `banner-img`

#### Scenario: Product card

- **WHEN** a product card for product `OLJCESPC7Z` renders
- **THEN** its link, card and image have ids `product-link-OLJCESPC7Z`, `product-card-OLJCESPC7Z` and `product-image-OLJCESPC7Z`

### Requirement: The cart icon loads behind the proxy

The cart icon in the header SHALL be rendered as a plain image element, not through the framework's image
optimiser. The optimiser rewrites the image URL in a way that breaks when the app is behind the proxy on
Kubernetes and leaves a broken icon.

#### Scenario: Behind the proxy

- **WHEN** the storefront is opened through the frontend proxy on a cluster
- **THEN** the cart icon loads

### Requirement: The platform label is hidden when unknown

The platform label SHALL show only when a platform name is known, taken from the deployment's platform setting.
When the setting is empty the label MUST NOT render at all, so users never see an empty box or the text
`undefined`. When shown, the label SHALL have the element id `platform`.

#### Scenario: Platform not configured

- **WHEN** no platform is configured
- **THEN** no platform element is on the page

#### Scenario: Platform configured

- **WHEN** a platform name is configured
- **THEN** the label shows it, with id `platform`

### Requirement: A failed order shows an error and keeps the cart

When placing an order fails, the cart page SHALL show the error message in red, bold text above the checkout
form, keep the shopper on the cart page with the cart intact, and clear the message at the next attempt. A
generic message, "Something went wrong placing your order.", SHALL be shown when the failure carries no message.
The error SHALL also be written to the browser console.

#### Scenario: Checkout service fails

- **WHEN** the shopper submits the form and the order call fails
- **THEN** the shopper sees the error text, stays on the cart page, and can retry

#### Scenario: Failure without a message

- **WHEN** the order call fails and the failure carries no message
- **THEN** the shopper sees "Something went wrong placing your order."

#### Scenario: Retry

- **WHEN** the shopper submits the form again after a failure
- **THEN** the earlier error message is cleared before the new attempt

### Requirement: Orders for the city Slowville are slow and nothing else is

`PlaceOrder` in `checkout` SHALL wait a random whole number of seconds, from 5 to 8 inclusive, before it starts
processing the order when the shipping address city contains "slowville", compared without regard to case (so
`Slowville`, `SLOWVILLE` and `New Slowville` all match). The order SHALL then be processed, charged and shipped
as usual. Any other city SHALL NOT be delayed. No feature flag controls this, and it produces no error.

#### Scenario: Slowville order

- **WHEN** an order is placed with city `Slowville`
- **THEN** the checkout call takes 5 to 8 seconds longer than usual and the order succeeds

#### Scenario: Case and substring

- **WHEN** an order is placed with city `New SLOWVILLE`
- **THEN** the checkout call is delayed by 5 to 8 seconds

#### Scenario: Other city

- **WHEN** an order is placed with city `Mountain View`
- **THEN** there is no added delay

### Requirement: The Slowville delay is idle time inside the PlaceOrder span

The delay SHALL happen at the start of `PlaceOrder`, before the order is prepared, and SHALL NOT be wrapped in a
child span, so it shows as time inside the `PlaceOrder` span before its first child span.

#### Scenario: Reading the trace

- **WHEN** a user opens the trace of a Slowville order
- **THEN** the `PlaceOrder` span has a gap of 5 to 8 seconds before its first child span

### Requirement: The slow group is found by grouping on city

The `PlaceOrder` span SHALL carry `demo.user_context.city` (string), the city of the shipping address of the order
being placed, on every order and before any delay or failure. The browser `placeOrder` span carries the same
attribute for the same order. A viewer who sees a slow tail on checkout duration therefore finds the cause by
grouping `PlaceOrder` duration by `demo.user_context.city`, where only Slowville stands out.

#### Scenario: Group by city

- **WHEN** a user groups `PlaceOrder` duration by `demo.user_context.city`
- **THEN** only `Slowville` stands out as slow

#### Scenario: City on the order span

- **WHEN** an order is placed with city `London`
- **THEN** the `PlaceOrder` span has `demo.user_context.city` = `London`

### Requirement: The storefront is the `api-gateway` cluster

All requests that match no other proxy route (the catch-all) SHALL be forwarded to the frontend under the upstream
cluster name `api-gateway`, so access logs and proxy metrics show `upstream.cluster` = `api-gateway`. The routing
result for users MUST be that the frontend serves the request. Requests whose path starts with `/images/` SHALL go
to the image provider, with the prefix replaced by `/`.

#### Scenario: Load the home page

- **WHEN** a user requests `/`
- **THEN** the page is served by the frontend and the access log record has `upstream.cluster` = `api-gateway`

### Requirement: Proxy access logs are their own service in Honeycomb

Proxy access log records SHALL be exported with the resource attribute `service.name` = `access-logs` and a
`hostname` resource attribute holding the proxy's host name. They SHALL NOT carry the proxy's own service name or
namespace. Per-request attributes, for example `upstream.cluster`, `url.path` and `event.name` = `proxy.access`,
SHALL stay on each record. The logs therefore arrive in their own dataset, apart from the proxy's traces.

#### Scenario: Query proxy logs

- **WHEN** a user queries Honeycomb for `service.name` = `access-logs`
- **THEN** every proxy access record is found, each with a `hostname`

### Requirement: Product images stream without buffering or redirect rewriting

The image provider SHALL turn off response buffering and SHALL NOT rewrite redirect locations. Images are
streamed to the client as they arrive, and the client sees the original location behind the cluster ingress.

#### Scenario: Large or slow image

- **WHEN** a browser fetches an image through the proxy
- **THEN** bytes reach it as the origin produces them, and any redirect keeps its original URL

### Requirement: Real-browser traffic is opt-in and weighted against HTTP traffic

The load generator SHALL run an HTTP user with relative weight `LOCUST_HTTP_USER_WEIGHT` (default 9) that waits a
random 1 to 10 seconds between tasks. When `LOCUST_BROWSER_TRAFFIC_ENABLED` is `true`, `yes` or `on`, it SHALL
also run a real-browser user (headless Chromium) with relative weight `LOCUST_BROWSER_USER_WEIGHT` (default 1).
The browser user is off otherwise. The target is the frontend proxy (`LOCUST_HOST`).

#### Scenario: Default settings

- **WHEN** `LOCUST_BROWSER_TRAFFIC_ENABLED` is unset
- **THEN** only the HTTP user runs

#### Scenario: Browser traffic on

- **WHEN** `LOCUST_BROWSER_TRAFFIC_ENABLED` is `true` and the weights are left at their defaults
- **THEN** about 1 in 10 simulated users is a real-browser user

### Requirement: Real browsers produce Web Vitals, sessions and linked traces

The real-browser user SHALL run two tasks with equal weight, each in a new root span. Every request the browser
makes SHALL carry `synthetic_request=true` in its baggage, added to any baggage already present, so the page is
served as synthetic and its browser spans carry `demo.synthetic_request` = `"true"`.

- `browser_change_currency` opens `/cart` and selects the currency `CHF`, then waits 2 seconds so the browser can export its telemetry.
- `browser_add_to_cart` opens `/`, waits up to 15 seconds for the Roof Binoculars image to load successfully, opens the Roof Binoculars product, clicks "Add To Cart", then waits 2 seconds.

A failure inside a browser task SHALL be logged and SHALL NOT stop the user.

#### Scenario: Currency change

- **WHEN** the currency task runs
- **THEN** the browser's requests carry the synthetic baggage and the cart page shows prices in CHF

#### Scenario: Add to cart by a browser user

- **WHEN** the add-to-cart task runs
- **THEN** Web Vitals, a click span and the add-to-cart trace down to the cart service exist for that browser's session

#### Scenario: Task failure

- **WHEN** the Roof Binoculars image does not load within 15 seconds
- **THEN** the failure is logged and the next task still runs

### Requirement: The homepage flood is switched by a feature flag

The HTTP user SHALL run a homepage flood task with relative weight 5 (next to browse a product 10, recommendations
3, ads 3, view cart 3, ask the agent 3, add to cart 2, single-item checkout 1, multi-item checkout 1, homepage 1).
The task SHALL read the flag `loadGeneratorFloodHomepage` as an integer over flagd's OFREP HTTP endpoint
(`FLAGD_HOST` and `FLAGD_OFREP_PORT`, defaults `localhost` and `8016`) before each run. It SHALL request `GET /`
that many times when the value is above 0 and do nothing otherwise. An unreadable flag counts as 0. The task runs
in a span named `user_flood_home` with the attribute `demo.request.flood.count` (int) holding the number of
requests. The flood requests carry baggage with the user's `session.id` and `synthetic_request=true`, and no trace
context, so each page request starts a fresh backend trace.

The flag is a number flag, state `ENABLED`, default variant `off`, with the description "Flood the frontend with a
large amount of requests.":

| Variant | Value |
| --- | --- |
| `off` | 0 |
| `on` | 100 |

#### Scenario: Flood on

- **WHEN** the flag is set to `on`
- **THEN** each flood task requests `/` 100 times and its span carries `demo.request.flood.count` = 100

#### Scenario: Flood off

- **WHEN** the flag is `off`
- **THEN** the flood task sends no request

#### Scenario: Flood is visible in the proxy

- **WHEN** the flood runs
- **THEN** the proxy access logs (`service.name` = `access-logs`, `upstream.cluster` = `api-gateway`) show a burst of `GET /` requests

### Requirement: Telemetry names are defined in the registry

Every attribute and flag-related name this use case relies on SHALL be defined in the demo's telemetry registry,
with the `demo.` prefix, never `app.`, and a semantic-convention name wherever one exists:

| Attribute | Type | Meaning |
| --- | --- | --- |
| `session.id` | string | the browser tab's session id (also set by the load generator per simulated user) |
| `enduser.id` | string | same value as `session.id`, for semantic-convention-based tools |
| `user.id` | string | shopper id on backend spans (semantic convention) |
| `demo.user_context.selected_currency` | string | currency the shopper selected |
| `demo.user_context.city` | string | city of the shipping address of the order being placed (examples `Mountain View`, `London`) |
| `demo.user_context.state` | string | state of the shipping address of the order being placed |
| `demo.synthetic_request` | string | `"true"` for generated traffic; on browser `fetch` spans |
| `demo.request.flood.count` | int | number of homepage requests a flood task sent |

The `frontend` service SHALL declare `session.id`, `enduser.id`, `user.id`, `demo.user_context.selected_currency`,
`demo.user_context.city`, `demo.user_context.state` and `demo.synthetic_request`. The `checkout` service SHALL
declare `demo.user_context.city`. The `load-generator` service SHALL declare `session.id`,
`demo.request.flood.count` and `demo.synthetic_request`. The attribute `app.user.city` MUST NOT be emitted. A
registry check MUST pass.

#### Scenario: Registry check

- **WHEN** the registry check runs
- **THEN** every name above resolves and is declared by the listed services

#### Scenario: Group by currency

- **WHEN** a user groups telemetry by `demo.user_context.selected_currency`
- **THEN** frontend telemetry groups under that one name

#### Scenario: Recording a shopper id

- **WHEN** the frontend records the shopper's id on a backend span
- **THEN** it uses `user.id`, not a `demo.` or `app.` attribute
