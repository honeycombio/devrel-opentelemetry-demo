# Plan: a "sharkfin" on checkout latency for the booth demo (promo order-history walk)

Status: built (see `devrel-README.md`, "Observatory Hour"). Where the build differs from this plan, "As built" at the
end says so. Numbers marked *(estimate)* were the plan's guesses; "As built" has the measured ones.

## What we want

- A latency fin on checkout API calls that climbs for about 30 minutes and then falls off a cliff.
- It runs on the booth, and the audience sees **one 6-hour window** in Honeycomb. The fin must be fully inside it.
- Narrative: a **new promo has just been activated**. Nothing was deployed. The code had shipped earlier, dormant.
- Plausible: ordinary code a team would ship, not a switch labelled "make it slow".
- Small blast radius: a handful of customers, a short time. P50 stays flat; P99 and the heatmap show the fin.
- Grounded in this demo's services (frontend, checkout, accounting, Postgres, product-catalog, currency, load generator).

"Sharkfin" here means: slow, steady climb, then a near-vertical drop.

## Why "promo lookup walks previous orders" works, and what it needs

Your idea is good: the cost grows with the number of previous orders, so it hurts valued customers and nobody else.
Two things stop it from being a fin by itself:

1. **Order history only grows.** A lookup over "all previous orders" gets slower forever and never falls off a cliff.
   The fin needs the walked history bounded to a recent period. A promo that is about *spend in the last 30 minutes*
   gives a natural bound: the history is empty when the promo starts, grows while shoppers buy, and is empty again
   30 minutes after they stop.
2. **Volume.** The load generator makes very few organic checkouts (5 locust users locally, so a few a minute
   *(estimate)*). Reaching a second or two from row counts alone would take hundreds of orders per customer.
   The cost per prior order has to be high, not just the number of orders.

The design below fixes both.

## Recommended scenario: "Observatory Hour"

### Narrative

**Before the booth (days earlier): a dark launch.** Aurelia (the telescope shop, `@aurelia.honeydemo.io`) builds a
members-only flash deal for the Aurelia Circle loyalty programme. The code ships in an ordinary PR and release. The
promo is behind a flagd flag that is **off**, so no one can use code `OBSERVATORY` and nothing changes in production.
This matters for the story: the PR, ticket and release all pre-date the incident, and the baseline in Honeycomb
is clean.

**At the booth: marketing activates it.** The promo is **"spend more, save more"** on accessories and books, counted
over the last 30 minutes:

| Eligible spend in the last 30 minutes | Discount |
|---|---|
| under $200 | 5% |
| $200 to $500 | 10% |
| over $500 | 15% |

Marketing wants astronomy clubs, schools and resellers to stock up, so a customer's second order can unlock a better
tier than their first. Someone flips the flag in flagd-ui. Honeycomb gets a marker for it automatically
(`Flag changed: promo.observatory-hour (off → on)`). A few minutes later checkout latency starts to climb for some
customers.

**The bug (real code).** To price the tier, checkout asks accounting "how much eligible spend has this customer had in
the last 30 minutes?" The orders table stores the final total, but not the discount or each line's category. So the
developer rebuilds the answer: load the customer's orders from the last 30 minutes, and for every order load its
items, look up every item's product in product-catalog to see if the category is eligible, and convert each cost to
USD with the currency service. That is N orders × M items × 2 gRPC calls, in series, when one `ListProducts` call and a
`SUM` would do.

It passed review and QA: test customers have one or two orders, and ordinary shoppers have none. It could not show
up before activation, because the flag was off.

**Who it hurts.** The bulk buyers marketing wanted: a few clubs and resellers placing order after order with 10 to 15
items each. Each order makes the next check slower. After about 30 minutes they finish shopping (or marketing
ends the promo), and latency falls off the cliff. Their old orders age out of the 30-minute lookback, so the next
activation starts from zero.

**The twist for the audience.** "Nothing was deployed, so why did latency change?" The answer is in the marker: a
flag was flipped. The cause is the code from an earlier PR, newly reachable.

### Why it is plausible

- Cumulative promo tiers are ordinary e-commerce features, and flash deals are about "the next 30 minutes".
- Not persisting the discount on the order is a common shortcut. "Replay the pricing for each old order" is the
  natural workaround.
- N+1 gRPC and SQL in a loop passes tests with tiny data. Only production-like customers expose it.
- Dark launch plus activation is how real teams ship promos.
- The fix is obvious in hindsight (store `discount_total` and `eligible_spend` on the order, or aggregate in SQL).
  That gives a clean "ship the fix, the next activation has no fin" ending.

### How the fin forms (mechanism)

```diagram
 PlaceOrder latency for the bulk buyers, as seen in the 6-hour Honeycomb view (not to scale)

   ▲
   │                  ╱│
   │               ╱   │
   │            ╱      │
   │         ╱         │
   ├───────╱───────────┴──────────────────────────────────────────▶ time
 -3 h      flag on     +30 min                                      +3 h
         (marker)      promo over: shoppers stop,
                       lookback empties
```

Cost of one check ≈ `orders_in_last_30_min × (2 SQL + items × (catalog gRPC + currency gRPC))`.
With about 12 items per bulk order and about 1.5 ms per RPC with spans *(estimate)*, that is roughly 30 to 45 ms per
prior order. About 50 prior orders gives 1.5 to 2.5 s *(estimate)*.

### Where it lives in the demo

```diagram
 browser / loadgen
        │  POST /api/checkout  { promoCode: "OBSERVATORY", email }
        ▼
   frontend ──▶ checkout (Go) ── PlaceOrder
                    │
                    │ NEW: ValidatePromo(email, code, cart)   (sync gRPC; only if flag is on)
                    ▼
               accounting (C#) ──▶ Postgres  accounting."order", orderitem
                    │   for each of the customer's orders in the last 30 minutes:
                    │     └─▶ product-catalog.GetProduct  (per item)
                    │     └─▶ currency.Convert            (per item)
                    ▼
               discount → checkout subtracts it → payment → shipping → Kafka → accounting (async persist, as today)
```

Today accounting is reached only asynchronously (Kafka) and by the frontend order APIs. A synchronous
checkout → accounting edge is new, and a believable one ("promos need order history, accounting owns it").
While the flag is off, checkout doesn't make the call at all.

### Activation: one flagd flag (as built: two states, `on` and `off`)

A flagd flag `promo.observatory-hour` with variants:

| Variant | Meaning | Used for |
|---|---|---|
| `off` (default) | Dormant. Promo code is rejected without any lookup. | Before the booth, after it, and the shipped state. |
| `on` | Promo is live until someone sets it back to `off`. | **The booth.** Flip it in flagd-ui in front of people. |
| `scheduled` (not built) | Live for 30 minutes of every 6 hours, by clock (`$flagd.timestamp % 21600 < 1800`). | Unattended runs. Would need string variants and the same clock rule in checkout and the loadgen. |

- This matches the repo's rule for stories: the flag only simulates the **business event** (marketing activates a
  promo). The slowness is real code that was already shipped.
- flagd-ui flag changes already post a Honeycomb marker. Here that is wanted: it is the "what changed?" clue, as
  opposed to the blind scenarios where `devrel-README.md` calls the marker a giveaway.
- Because the lookback is 30 minutes, nothing needs cleaning up. If the flag stays on past 30 minutes, the history
  window stops growing, so the damage is bounded. The loadgen buyers also stop after one 30-minute session (below).

### The bulk-buyer persona (load generator)

- One locust user class with `fixed_count = 1` per bulk buyer, so extra loadgen replicas don't multiply the cohort.
- 2 customers with their own emails (for example `circle-club-1@aurelia.honeydemo.io`). Don't reuse
  `loyal-vip-1..3`, which `storechatRefundBackupOrders` already drives; that would couple two stories.
- Session logic, kept to a small state machine:
  - The buyer is **armed** at start and whenever it sees the flag `off`.
  - When it sees the flag not `off` and is armed, it starts a **30-minute session** and disarms.
  - In a session: add 10 to 15 items to the cart, check out with `OBSERVATORY`, wait 20 to 40 s, repeat. It stops when
    the 30 minutes are up or the flag goes `off`.
  - After a loadgen restart mid-promo it simply starts a fresh session. That is harmless.
- About a third of organic checkouts also send the code while the flag is on. They have no recent orders, so they are
  fast. This is the control group that makes the story readable.
- Volume: roughly 1 to 2 orders a minute per buyer *(estimate)*, about 100 orders in the session, against organic
  checkouts of a few a minute. A visible but modest pulse, and a good red herring ("is it just traffic?").
- Keep `cartservice.add-db-call` off (it is off by default). It adds 100 to 300 ms per item for carts over 6 items
  and would muddy the buyers' traces.

### Booth run sheet (proposal)

| When | What |
|---|---|
| Days before | Release the dormant feature. Confirm in Honeycomb that checkout is clean and the flag is `off`. |
| Morning of | Check Kafka and accounting pods are healthy (orders must reach Postgres). Confirm flagd has the flag (see risks). |
| Before visitors | Set the Honeycomb view to the last 6 hours, with the PlaceOrder P99 / heatmap query and the marker visible. |
| Showtime | Flip `promo.observatory-hour` to `on` in flagd-ui. Say "marketing just turned on the Observatory Hour promo." |
| +5 to +10 min | The ramp becomes visible. Start the investigation. |
| +30 min | Fin drops. Flip the flag back to `off` ("promo over"). |
| Repeat | Flip again whenever a new audience arrives. Each run is a fresh fin; the lookback empties by itself. |

Rehearse against the local team (`scripts/local-honeycomb-destination.sh`) and not prod, so the prod 6-hour view only
shows the real activation. If you rehearse in prod, do it more than 6 hours earlier.

### What you see in Honeycomb

Instrument these so the story is findable:

- `checkout`: on `PlaceOrder`, `app.promo.code`, `app.promo.discount_percent`, `app.promo.orders_scanned`,
  `app.promo.validation_ms`.
- `accounting`: on `ValidatePromo`, `app.promo.orders_scanned`, `app.promo.items_scanned`.
- Keep existing auto-instrumentation, so every catalog and currency call shows as a child span.

The investigation path:

1. Heatmap of `duration_ms` for `oteldemo.CheckoutService/PlaceOrder` (and `POST /api/checkout`) over the last
   6 hours: flat, then a fin. P50 stays flat.
2. The marker at the foot of the fin: `Flag changed: promo.observatory-hour (off → on)`. Nothing was deployed.
3. BubbleUp on the fin: `app.promo.code = OBSERVATORY`, high `app.promo.orders_scanned`, and `app.user.id` / email
   concentrated in two customers.
4. Open a slow trace: a long staircase of repeated `GetProduct` and `Convert` child spans under `ValidatePromo`
   (about a thousand in the latest orders, a handful in a fast one).
5. Group `ValidatePromo` duration by `app.promo.orders_scanned`: a clean straight line. That is the proof of cause.
6. Tie it to the code: the PR that added Observatory Hour, merged days before. This mirrors the Slow login story, so
   the Canvas connectors (GitHub PR, Linear ticket) can be pointed at it.

Alerting:

- A trigger like "PlaceOrder P99 > 1 s" would fire 10 to 20 minutes into the session and resolve after it. With one
  activation at a time, wiring it to incident.io (as the Slow login story does) could be a feature: an incident opens
  live while you are talking. Decide on purpose, and remember it opens an incident every time you run the demo.
- Checkout Availability (the SLO) will not move, because nothing errors. A tiny cohort barely burns any latency
  budget while the fin is obvious.

### Changes

1. **Proto (`pb/demo.proto`)**: add `promo_code = 8` to `PlaceOrderRequest`. Add `ValidatePromo` to `OrderService`
   with request and response messages. Regenerate (Go, C#, TS, Python loadgen if it uses stubs).
2. **Accounting**: `ValidatePromo` in `OrderServiceImpl.cs`. Rejects fast if the flag is `off`. Otherwise walks
   `Orders where Email == x && CreatedAt >= now - 30 min` with the naive loop above. Needs gRPC clients for
   product-catalog and currency, and their addresses in config.
3. **Checkout**: call `ValidatePromo` before `chargeCard` when a promo code is present, subtract the discount from
   `total`, add span attributes. Add `ACCOUNTING_ADDR` to checkout's env in `skaffold-config/demo-values.yaml`,
   `deploy/applications/oteldemo.ts` and docker-compose.
4. **Frontend**: promo code input in `CheckoutForm`, pass `promoCode` through `/api/checkout`.
5. **flagd (`src/flagd/demo.flagd.json`)**: the `promo.observatory-hour` flag with its three variants.
6. **Load generator (`locustfile.py`)**: the bulk-buyer persona and the organic promo share.
7. **Docs**: a "Demo stories" entry in `devrel-README.md`, in the style of Slow login and Mastercard 2-series,
   including the run sheet.
8. **Store-chat prompt**: `src/storechat/agents.py` says "we never issue promotional codes through this channel".
   That still holds for the chat, so leave it. The chat won't know the promo exists.

## History from past weeks: dropped

Earlier I proposed backfilling a week of past windows. That contradicts "just activated": a promo that has run for a
week isn't new, and fake fins before the PR's merge date would break the "what changed?" story. Real data from the
booth run is enough, since the 6-hour view will contain one real fin. If you later want a "this keeps happening"
variant, the options were: run the `scheduled` variant for a few days beforehand (real data, no fakery), or backfill
telemetry and orders with a script. I would only use those for a different story.

## Shape options

| Shape | How | Notes |
|---|---|---|
| Ramp and cliff (recommended) | Lookback of 30 minutes; shoppers stop after a 30-minute session | Matches a dorsal fin. Resets itself. |
| Spike and slow decay | A batch of orders lands at once, so the walk starts large and shrinks as orders age out | Needs a batch importer, more invention. |

A longer session (45 to 60 min) gives a wider fin, which is easier to see on a 6-hour view (30 minutes is 8% of
the width). It needs the lookback to be at least as long as the session.

## Calibration (do this before committing the numbers)

The amplitude depends on per-RPC latency, which differs between the orb's k3d cluster and the AKS/EKS cluster.

1. Build the feature and run it locally (`.agents/orb-run accounting checkout frontend load-generator`).
2. Seed N orders for one email inside the lookback and time `ValidatePromo` at N = 10, 25, 50, 100.
3. Fit ms per order. Pick items per order and orders per session to hit about 2 s at the end.
4. Check the organic checkout rate in prod Honeycomb to size the cohort so buyer orders stay a modest share.
5. Do a full dress rehearsal in the local environment, from flag flip to cliff, and look at the 6-hour view.

## Risks and open points

- **A release resets flags.** `CLAUDE.md` notes that flagd copies its flag file only at pod start, and a prod release
  restarts flagd. A release during the booth would flip the flag back to `off` and cut the demo short. Freeze
  releases for the day. And after the release that adds this flag, flagd has to restart for it to appear.
- **Kafka dependency.** Orders reach Postgres only through Kafka and accounting. If Kafka is down or crash-looping,
  the history is empty and there is no fin. Check pods before the booth opens.
- **Postgres index.** `accounting."order"` has an index on `email` only. The walk filters on `email` and `created_at`,
  which is cheap per customer. Don't use a predicate that defeats the index (for example `lower(email)`), or the cost
  would depend on table size and hit everyone.
- **Payment's transaction store is in memory.** Not used by this design (deliberately), so no dependency on payment
  restarts.
- **The first minutes look flat.** The fin is flat by design at the start; expect a visible rise from about minute 5.
- **Cardinality.** Two synthetic emails. No real PII.

## Other scenarios considered

| # | Scenario | Services | Fin mechanism | Blast radius | Verdict |
|---|---|---|---|---|---|
| 1 | **Observatory Hour** (above) | checkout, accounting, product-catalog, currency, postgres | History in the lookback grows with each bulk order; shoppers stop | 2 customers | **Recommended.** Your idea, with the bounding and cost fixed, and a natural "activated, not deployed" story. |
| 2 | **Unbounded history walk, always on** | checkout, accounting | Walk "all previous orders" for loyalty tier | Valued customers, always | Not a fin: worsens forever and needs hundreds of orders. A steady-slowness story. |
| 3 | **Promo reservation ledger plus sweeper job** | checkout, accounting, postgres, a k8s CronJob | Each "apply code" writes a reservation row; validation scans the customer's rows; a sweeper deletes expired ones | Customers who re-apply the code often | Self-resetting by a real job, but needs a new table and a CronJob (none exist in `deploy/`). Fits a second story. |
| 4 | **Login event history check** | auth, postgres | "New device" check reads `auth.login_event` rows; retention purge resets | Frequent corporate users | Plausible, the table exists. But `auth` is already the Slow login story. |
| 5 | **Reviews for a spotlighted product** | product-reviews, ad, postgres | `SELECT *` with no limit grows as reviews arrive | Viewers of one product | Nice and local, but there is no review write path to drive growth. |
| 6 | **Memory growth then pod restart** | any one service | Latency climbs as a structure grows; OOM kill resets | Everyone | Natural fin, but affects all users and looks like an outage. |
| 7 | **Batch job holding locks or saturating the pool** | accounting, postgres | Job runs for a few minutes | Order lookups | A square wave, not a fin, unless job cost grows during the run. |

## Decisions needed from you

1. Is my reading of "a single 6-hour window" right: the Honeycomb view covers 6 hours, and the booth shows one
   30-minute fin inside it, started live by flipping the flag?
2. Do you want the booth operator to flip the flag by hand in flagd-ui (`on`), with `scheduled` only as a fallback?
3. Session length: 30 minutes (default) or 45 to 60 for a wider fin?
4. Cohort: two new bulk-buyer emails, or reuse `loyal-vip-*`?
5. Should a fix PR be prepared in advance (store the discount on the order), so the demo can end with "ship the fix"?
6. Should the latency trigger open an incident in incident.io live, or notify Slack only?

## As built

- **Flag:** `promo.observatory-hour`, boolean, `on` / `off`, default `off`. No `scheduled` variant: flagd-ui only edits
  the default variant, so a clock rule would have to live in code in two places. Add it if you want unattended runs.
- **Checkout** (`src/checkout/main.go`): when the flag is on and the request has a promo code, `applyPromo` calls
  `OrderService/ValidatePromo` and subtracts the discount. A failed validation is logged and skipped, never a failed checkout.
  Span attributes: `app.promo.code`, `app.promo.validation_ms`, `app.promo.valid`, `app.promo.discount_percent`,
  `app.promo.orders_scanned`, `app.promo.items_scanned`.
- **Accounting** (`src/accounting/OrderServiceImpl.cs`): `ValidatePromo`, the naive loop over the customer's orders from the
  last 30 minutes. It needs `PRODUCT_CATALOG_ADDR` and `CURRENCY_ADDR`, set in `deploy/config-files/demo/values.yaml`
  and `docker-compose.yml`. Checkout gets `ACCOUNTING_ADDR` the same way.
- **Frontend:** an optional "Promo Code" field on the checkout form.
- **Load generator:** `CircleClubBuyer` (two per process), a third of ordinary checkouts send the code while the flag is on.
  Orders are every 10 to 20 s, not 20 to 40 s: the measured cost per earlier order was lower than estimated.
- **A cart holds each product once**, so an order has at most 8 to 10 lines (not 10 to 15). The buyers buy all five promo
  products and three others.
