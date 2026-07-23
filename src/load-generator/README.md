# Load Generator

The load generator creates simulated traffic to the demo using
[k6](https://k6.io/).

## Modifying the Load Generator

The load test script lives at [`script.js`](./script.js). See the [k6
documentation](https://grafana.com/docs/k6/latest/) for more on writing k6
scripts.

Tracing and log correlation are provided by a custom k6 extension,
[`xk6-otel`](./xk6-otel), which exposes a `Tracer` to the script (imported as
`k6/x/otel`) for creating OTel spans. Outbound HTTP requests deliberately omit
the `traceparent` header (see `otelHeaders()` in `script.js`) so downstream
services start fresh root traces instead of getting stitched into the load
generator's own trace tree, matching how real edge traffic looks; `baggage`
(with `synthetic_request=true`) still propagates so synthetic traffic stays
identifiable.

The extension also emits Go runtime metrics (memory, GC, goroutines) via the
OTel contrib `runtime` instrumentation. These are separate from k6's own
built-in test metrics, which are exported via the `--out opentelemetry` output
enabled in [`entrypoint.sh`](./entrypoint.sh)'s `k6 run` invocation; the OTLP
endpoint and protocol for that output are configured via the `K6_OTEL_*` env
vars in `compose.yaml`.

## Traffic mix

Each `httpScenario` iteration picks one task at random, weighted so browsing
dominates over checkout:

| Task                       | Weight |
| --------------------------- | -----: |
| `index`                     |      1 |
| `browseProduct`             |     10 |
| `getRecommendations`        |      3 |
| `getAds`                    |      3 |
| `viewCart`                  |      3 |
| `addToCart`                 |      2 |
| `checkout`                  |      1 |
| `checkoutMulti`             |      1 |
| `floodHome`                 |      5 |
| `askStoreChat`              |      1 |
| `askStoreChatPastedEmail`   |      1 |
| `askStoreChatRefundBackup`  |      1 |

The last three drive `store-chat` (the post-purchase customer-service agent):
placing an order, then running a multi-turn conversation against it (order
status, shipping, refunds). All three are gated on `AGENT_LOAD_ENABLED` (opt-in
— see below) and rate-limited to roughly once per VU per 10 minutes, since they
hit Bedrock and are what dominates AI spend in this demo.

- `askStoreChat` runs a randomized multi-turn conversation from
  `STORE_CHAT_CONVERSATIONS`.
- `askStoreChatPastedEmail` is a rare scenario simulating a customer pasting an
  entire forwarded email thread into one chat turn — `/store-chat/chat`
  doesn't bound the `question` size, so this single conversation spikes
  `gen_ai.usage.input_tokens` well above a normal session.
- `askStoreChatRefundBackup` is additionally gated on the
  `storechatRefundBackupOrders` flag: it reuses a tiny fixed pool of emails
  (`BACKUP_REFUND_EMAILS`) so orders accumulate against each one across runs —
  `lookup_orders` has no pagination, so the refund agent's tool-result JSON
  (and its input token count) grows over time.

## Controlling traffic and concurrency via feature flags

* `loadGeneratorTraffic` - pauses all synthetic traffic (both scenarios) when
  turned off, checked every iteration with no restart required.
* `loadGeneratorVUs` - sets the number of concurrent virtual users the HTTP
  scenario runs. k6 v2's `constant-vus` executor can't resize its VU pool at
  runtime - it dropped the externally-controlled executor, and its REST API
  now rejects live VU changes outright - so
  [`entrypoint.sh`](./entrypoint.sh) polls flagd and restarts k6 with the new
  VU count only when this flag's value actually changes, rather than on a
  fixed timer.
* `AGENT_LOAD_ENABLED` (env var, not a flagd flag) - opts in the store-chat
  tasks above. Off by default for local `*-local` namespaces so multiple
  developers don't all hammer the shared account's Bedrock concurrently; set
  to `true`/`yes`/`on`/`1` in the deployed environment to enable.
* `storechatRefundBackupOrders` - additionally gates `askStoreChatRefundBackup`
  (see above).

`entrypoint.sh` passes the VU count to k6 through the `LOAD_GENERATOR_VUS`
env var, which `script.js` reads directly via `__ENV` to set the HTTP
scenario's `vus`. It is deliberately not named `K6_VUS`: a `K6_VUS` env var
(or `--vus` flag) makes k6 discard the script's `scenarios` config entirely in
favor of a single implicit scenario, the same way `K6_DURATION`/
`K6_ITERATIONS`/`K6_STAGES` do - so none of those reserved names should ever
be set as a container env var here.

The browser scenario runs a single headless browser session alongside the HTTP
traffic, so it always runs one browser VU. It is opt-in via `K6_BROWSER_ENABLED`
(default off), since headless Chromium requires a relaxed pod security context
that most Kubernetes clusters don't grant by default. When enabled, Chromium's
executable path and launch args come from the `K6_BROWSER_EXECUTABLE_PATH` and
`K6_BROWSER_ARGS` env vars (comma-separated, no `--` prefix) rather than the
scenario's own `browser` options field, which k6 ignores for these.
