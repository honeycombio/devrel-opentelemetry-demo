# Error-aware eval sampling via collector tail sampling

## Goal

Change how the LLM-eval pipeline decides *which* chat turns get scored:

1. **Every trace that contains an error gets evaluated** (don't drop a failed chat turn).
2. **1 in 10 of the remaining `invoke_agent supervisor` turns** get evaluated.

Move the sampling decision out of the consumer and into the OTel Collector, using
`tailsamplingprocessor`, so we also stop shipping 100% of anchor spans to Kafka.

## Current state (before this change)

- Sampling lives in the **consumer**: `src/llm-evals/src/index.ts:202` does
  `if (Math.random() >= EVAL_SAMPLE_RATE) return null` per anchor span. Default
  `EVAL_SAMPLE_RATE = 0.1` (env var unset everywhere).
- The collector keeps **100%** of eval-anchor spans (`filter/keep_eval_anchors`)
  and ships them all to Kafka; the consumer then throws ~90% away. So we pay full
  Kafka volume regardless of the sample rate.
- The eval anchors are: store-chat `invoke_agent supervisor` and product-reviews
  `chat *` spans.

## Key finding that shaped the design

Over 24h in the `demo` env: **0 of 3012** `invoke_agent supervisor` spans carry
`error=true` / `status_code=ERROR`. The errors live on **child** spans emitted by
store-chat itself in the same process:

- `execute_tool get_order` — 863 errors
- `gen_ai.client.inference.operation.details` — 1728 errors
- `exception` — 864

So "trace has an error" is a **trace-level** property the anchor span doesn't
reflect. A stateless OTTL filter can only see the current span, so it cannot
express "keep this anchor if a sibling span errored" — which is exactly why we
need a tail sampler (it groups spans by trace ID and decides over the set).

## Why tail sampling works on a DaemonSet collector here

Tail sampling normally needs the whole trace co-located on one collector
instance. The eval pipeline runs on the **DaemonSet** collector
(`pod-telemetry-collector`, `mode: daemonset`), and a full chat trace *is*
fragmented across collectors (frontend-proxy, api-gateway, store-chat, downstream
services are different pods → different collector pods via the ClusterIP Service).

It still works because **the sampling decision only needs spans that store-chat
emits in-process**:

- The anchor (`invoke_agent supervisor`) is a store-chat span.
- The error signal is on store-chat's own child spans (`execute_tool …`,
  `gen_ai.client.inference …`, `exception`) — store-chat records downstream
  tool/Bedrock failures as ERROR on its *own* spans.

A single chat turn is handled by one store-chat replica = one process = one
OTLP/gRPC connection, which kube-proxy pins to one collector pod. So every span
that turn emits lands on **one** collector instance, together. The fragments on
other nodes are exactly what `filter/keep_eval_services` discards and the decision
doesn't need.

`tailsamplingprocessor` also does **not** need the root span — it has no trace
completeness/root detection. It groups by trace ID, waits `decision_wait` from the
first span seen, then evaluates policies over whatever it holds. Our two policies
are root-independent:

- `probabilistic` hashes the **trace ID** → identical decision regardless of which
  spans are present (also consistent across collectors if a turn ever splits).
- `status_code: [ERROR]` fires if any held span is ERROR — store-chat's error
  spans are in this fragment.

(`latency` and `span_count` policies *would* be wrong on a fragment — we use
neither.)

### When this design would break

- **Cross-service error signal**: if we ever needed to key the decision on a span
  a *different* service emits (e.g. downstream errored but store-chat reported
  success), that span is on another node's collector → invisible. Today store-chat
  marks its own spans on failure, so this is fine — but it's the load-bearing
  assumption.
- **Connection churn mid-turn**: if store-chat's gRPC channel reconnects during a
  turn (collector rollout, keepalive expiry), later spans can re-pin to a
  different collector pod → the turn splits. Worst case is a duplicate or missed
  eval, not corruption — and the consumer already tolerates duplicate eval spans.

### Hardening

- **`internalTrafficPolicy: Local`** on the collector Service → each app pod talks
  to the collector **on its own node**, making the colocation deterministic and
  removing the connection-pinning fragility. The DaemonSet guarantees a collector
  per node, so it's safe. Also localizes eval buffering to the node(s) running
  store-chat/product-reviews.
- **Gateway tier** (not doing this now): agents → `loadbalancingexporter` (routes
  by trace ID) → Deployment of gateway collectors running `tail_sampling`. The
  canonical pattern; only needed if a decision ever requires cross-service trace
  context.

## Memory impact

`tailsamplingprocessor` buffers every span of in-flight traces for `decision_wait`.
Because `filter/keep_eval_services` runs **before** it, only store-chat +
product-reviews spans are buffered (never the cluster firehose).

- ~3012 turns/24h ≈ 0.035 turns/sec; ~15–30 spans/turn → ~0.5–1 span/sec.
- `decision_wait = 30s` → ~1 turn / a few dozen spans resident.
- gen_ai spans dominate size (input/output messages + ~6k-token handbook system
  prompt, ~25–50 KB each, several per turn) → ~0.5–1 MB per turn.
- **Steady state ≈ ~1 MB; a 10× burst ≈ single-digit MB.**
- `internalTrafficPolicy: Local` localizes this to the node(s) running those
  services — not ×(node count).
- `num_traces` is an LRU *bound* (small fixed ID-ring cost), not a pre-allocation
  of span memory.

There is currently **no `memory_limiter`** in the pipelines and no explicit pod
memory limit in the daemonset values. The eval buffer is tiny, but we'll add a
`memory_limiter` to the evals pipeline as belt-and-braces.

**Mistake to avoid:** never put `tail_sampling` before `filter/keep_eval_services`
— that would buffer the whole cluster (~70+ spans/sec, spiky) for `decision_wait`.

## Implementation

### 1. Add `tailsamplingprocessor` to the custom collector build

`deploy/config-files/custom-collector/ocb-config.yaml` — add under `processors:`:

```yaml
- gomod: github.com/open-telemetry/opentelemetry-collector-contrib/processor/tailsamplingprocessor v0.151.0
```

Requires rebuilding the `otelcollector` image. (Prod runs the custom `otelcol-dev`
build — confirmed by the use of the `drain` processor, which only exists there.)

### 2. Wire tail sampling into the prod collector evals pipeline

`deploy/config-files/collector/values-daemonset.yaml`:

- Add a service-level pre-filter:

```yaml
filter/keep_eval_services:
  error_mode: ignore
  traces:
    span:
      - 'resource.attributes["service.name"] != "store-chat" and resource.attributes["service.name"] != "product-reviews"'
```

- Add the tail sampler:

```yaml
tail_sampling/evals:
  # Must outlast a chat turn so the trace fragment is complete before deciding.
  decision_wait: 30s
  # LRU bound on in-flight traces; far above expected concurrency here.
  num_traces: 2000
  expected_new_traces_per_sec: 10
  policies:
    # Always evaluate a turn whose (store-chat/product-reviews) fragment errored.
    - name: errors
      type: status_code
      status_code:
        status_codes: [ERROR]
    # Otherwise sample ~10%, hashed on trace ID.
    - name: sample-rest
      type: probabilistic
      probabilistic:
        sampling_percentage: 10
```

- (belt-and-braces) add a `memory_limiter` processor and include it first in the
  evals pipeline.

- Rewire the `traces/evals` pipeline (order matters):

```yaml
traces/evals:
  receivers: [otlp]
  processors:
    - memory_limiter
    - filter/keep_eval_services      # drop non-eval services BEFORE buffering
    - tail_sampling/evals            # error-always + 10% probabilistic
    - transform/genai_span_events_to_attributes
    - filter/keep_eval_anchors       # trim kept traces to just the anchor span
  exporters: [kafka/llm-evals]
```

- Add `internalTrafficPolicy: Local` to the collector `service:` block.

### 3. Mirror in the skaffold (local) collector config

`skaffold-config/demo-values.yaml` carries the same eval pipeline and runs the
same custom build. Apply the identical `filter/keep_eval_services`,
`tail_sampling/evals`, `memory_limiter`, pipeline reorder, and
`internalTrafficPolicy: Local`.

### 4. Stop the consumer re-sampling (avoid compounding to 1%)

The consumer defaults to `EVAL_SAMPLE_RATE = 0.1`. With sampling now in the
collector, leaving it would multiply 10% × 10% = ~1% effective. Set it to `1.0`:

- `deploy/applications/otel-services.ts`: add to `services.llmEvals`:

```ts
env: [{ name: "EVAL_SAMPLE_RATE", value: "1.0" }],
```

  (rendered into the deployment by the existing `range .Values.services.llmEvals.env`).

- Update the comment in `src/llm-evals/src/index.ts` to note that primary sampling
  now lives in the collector tail sampler; `EVAL_SAMPLE_RATE` is a secondary
  control kept at 1.0.

## Deploy / verify

- Rebuild + deploy: `AWS_PROFILE=devrel-sandbox ./run otelcollector` (plus
  redeploy the chart so the consumer env + collector config land).
- Verify in Honeycomb (`demo` env):
  - All `invoke_agent supervisor` turns whose trace errored produce an
    `eval - llm-evals` trace.
  - Non-error turns produce evals at ~10%.
  - Kafka `llm-evals-spans` volume drops ~90%.
  - Collector pod memory on store-chat's node stays flat (low single-digit MB
    delta).

## Open questions / decisions taken

- **Tail sampler over app-side flag**: chosen for collector-side control + ~90%
  Kafka reduction, accepting the rebuild + `decision_wait` latency.
- **No gateway tier**: the decision is intra-service, so DaemonSet +
  `internalTrafficPolicy: Local` is sufficient. Revisit only if a future eval
  decision needs cross-service trace context.
- **`decision_wait = 30s`**: comfortably above a few-second turn; the anchor
  (parent) span ends last, so too-short a window risks missing it.
