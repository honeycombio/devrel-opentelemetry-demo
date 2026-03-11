# Cart Feature Flag Demo: Improving Telemetry for a Realistic Demo

## Goal

Demonstrate in Honeycomb how a platform user can identify that a new feature (controlled by a feature flag) caused a degradation in performance — increased response time and/or error rates.

The feature flag `cartservice.add-db-call` in the cart service simulates a realistic scenario: "We added per-item database lookups to enrich cart data." When the flag is ON, the cart service does an individual database query per item instead of relying solely on the Redis cache. This is a classic N+1 query problem.

## What we found (problems with the existing code)

### 1. Feature flag span events are wasteful

The OpenFeature tracing hook (`TraceEnricherHook`) emits feature flag evaluations as **span events**, not span attributes. In Honeycomb, each span event becomes a separate billable event. For the cart service:

- ~50% of all events in the cart dataset are span events
- Each flag evaluation produces ~8 Honeycomb events (the flag eval event itself, plus the flagd gRPC call chain: ResolveBoolean client span, POST span, flagd server spans, etc.)
- The flag data (`feature_flag.key`, `feature_flag.result.variant`) lives on span events, not on the parent span — so you can't GROUP BY or BubbleUp on it

**Fix**: Set the flag result as a span attribute directly: `activity?.SetTag("app.feature_flag.cart_db_call", shouldDoDatabaseCall)`. One attribute on the span replaces 8 events.

ALSO: all the trace spans related to calling flagd and then the flagd service tracing itself is wasteful. I would like to turn all that off somehow.

### 2. Fake database spans don't export

The existing code creates fake DB spans using `ActivitySource("Database")`, but that source is never registered with the trace provider (which only has `.AddSource("OpenTelemetry.Demo.Cart")`). So the spans are created but never exported. The `Task.Delay` still happens, making GetCart slow, but the trace shows no child spans explaining why.

### 3. The flagd ConfigMap drifts from source

The upstream Helm chart bakes its own `flagd/demo.flagd.json` into the ConfigMap via `.Files.Glob`. This file is missing `cartservice.add-db-call`, `llmInaccurateResponse`, and `llmRateLimitError`. Every deploy resets the ConfigMap to the upstream's incomplete set.

**Fix**: `scripts/patch-flagd-configmap.sh` syncs the deployed ConfigMap with `src/flagd/demo.flagd.json`. It's now called automatically at the end of `./run`.

### 4. Fractional flag evaluation needs targetingKey

flagd's `fractional` operator requires a `targetingKey` in the evaluation context. The cart service was only setting `app.user.id` as a regular property.

**Fix**: Added `.SetTargetingKey(request.UserId)` to the evaluation context builder.

## Plan: Replace fake DB spans with real PostgreSQL queries

Instead of fake `ActivitySource("Database")` spans with `Task.Delay`, use the real PostgreSQL instance that already runs in the cluster (currently empty).

### Changes to `src/cart/src/cart.csproj`

- Add `Npgsql` package (the .NET PostgreSQL driver)
- Add `Npgsql.OpenTelemetry` package (auto-instrumentation)

### Changes to `src/cart/src/Program.cs`

- Register Npgsql's OpenTelemetry instrumentation: `.AddNpgsqlInstrumentation()` on the tracing builder
- Create and register a shared `NpgsqlDataSource` pointing at the existing PostgreSQL service (`postgresql:5432`, db `otel`, user `root`, password `otel`)

### Changes to `src/cart/src/services/CartService.cs`

- Inject `NpgsqlDataSource` into CartService
- On startup (or first use), ensure a `products` table exists with some seed data
- When flag is ON: do a real `SELECT * FROM products WHERE id = @id` per cart item
- When flag is OFF: no database call (just Redis as before)
- Remove the fake `ActivitySource("Database")` and `Task.Delay`
- Keep `activity?.SetTag("app.feature_flag.cart_db_call", shouldDoDatabaseCall)` for the span attribute

### What the trace looks like

**Flag OFF** (baseline):

```
GetCart (~3ms)
  ├── HGET (Redis, ~1ms)
  └── SELECT * FROM products WHERE id = ANY($1) (PostgreSQL, <1ms, batch)
```

**Flag ON** (N+1 problem):

```
GetCart (50-1200ms depending on cart size)
  ├── HGET (Redis, ~1ms)
  ├── SELECT * FROM enrich($1) (PostgreSQL, 10-200ms random)
  ├── SELECT * FROM enrich($1) (PostgreSQL, 10-200ms random)
  ├── SELECT * FROM enrich($1) (PostgreSQL, 10-200ms random)
  ... (one per cart item)
```

The `enrich()` function is a PostgreSQL function that does a `pg_sleep(random)` + SELECT, making the N+1 pattern immediately visible in the trace waterfall. BubbleUp on slow GetCart spans surfaces `app.feature_flag.cart_db_call = true` as the differentiator.

### Honeycomb board

**[Cart Product Enrichment](https://ui.honeycomb.io/modernity/environments/devrel-demo--local-/board/uG5R5NiHQ6F)** — board in the `devrel demo "local"` environment with flag status, GetCart performance (heatmap, P50/P95, error rate, SLO), business metrics (Add to Cart volume, checkout revenue), and database query patterns.

### Useful Honeycomb queries

- **Flag distribution metric**: `otlp-metrics` dataset, `SUM(feature_flag.flagd.impression)` grouped by `feature_flag.result.variant`, filtered to `feature_flag.key = cartservice.add-db-call`
- **Latency heatmap**: `cart` dataset, `HEATMAP(duration_ms)` filtered to `name = POST /oteldemo.CartService/GetCart`

## Demo flow

1. Show baseline in Honeycomb: cart service performing well, low latency
2. Run `./scripts/set-flag-percentage.sh 50` to roll out to 50% of users
3. In Honeycomb, show latency increase in the cart service heatmap
4. Use BubbleUp to identify `app.feature_flag.cart_db_call = true` correlates with slow requests
5. Drill into a trace to see the N+1 query pattern
6. Optionally: `./scripts/set-flag-percentage.sh 0` to turn it off, show recovery

## Status

- [x] `scripts/patch-flagd-configmap.sh` — syncs flags, uses Helm-compatible field manager
- [x] `scripts/set-flag-percentage.sh` — adjusts rollout percentage
- [x] `./run` calls patch script after skaffold deploy
- [x] ECR repo `localdemo/cartservice` created
- [x] `.SetTargetingKey(request.UserId)` added to evaluation context
- [x] `activity?.SetTag("app.feature_flag.cart_db_call", shouldDoDatabaseCall)` added
- [x] Add Npgsql + Npgsql.OpenTelemetry to cart service
- [x] Create products table and seed data (10 products matching the demo catalog, seeded on startup via `EnsureProductsTableAsync`)
- [x] Replace fake DB spans with real PostgreSQL queries
- [x] Remove `ActivitySource("Database")` and `Task.Delay`
- [x] Get the database spans a better name — used `NpgsqlDataSourceBuilder.ConfigureTracing` with `ConfigureCommandSpanNameProvider(cmd => cmd.CommandText)` so spans show the actual SQL
- [x] Make flag-ON path realistically slow — created a PostgreSQL function `enrich(product_id)` that does `pg_sleep(0.01 + random() * 0.19)` (10-200ms random) before the SELECT. Span name shows `SELECT * FROM enrich($1)` which reads naturally.
- [x] Deploy and verify in Honeycomb — heatmap shows clear bimodal split: ~3ms baseline vs 35-1200ms for flag-ON
- [x] Disable first-response span event from Npgsql — `EnableFirstResponseEvent(false)` deployed
- [x] Remove tracing from flagd service — collector `filter/drop_flagd_traces` drops all spans where `service.name == "flagd"` in `values-daemonset.yaml`. Env var approaches (`OTEL_TRACES_EXPORTER=none`) didn't work because flagd uses custom telemetry config that ignores standard OTel SDK env vars.
- [ ] Consider: remove or reduce the OpenFeature tracing hook's span events (they're expensive noise)
- [ ] Can we also remove the client spans that call flagd? (cart service emits gRPC client spans for ResolveBoolean calls). Removed `.AddHttpClientInstrumentation()` but gRPC client spans remain.
