# Research: replacing the frontend browser telemetry with `@opentelemetry/browser-sdk`

Date: 2026-09-16. Scope: browser-side telemetry in `src/frontend` only. The Next.js server-side
Node SDK (`src/frontend/utils/telemetry/Instrumentation.js`) is out of scope and stays as-is.

All claims cite primary sources (GitHub source, npm registry metadata, OpenTelemetry semantic
conventions). Items marked **[unverified]** could not be confirmed from a primary source.

## Summary and verdict

**Verdict: feasible with caveats.** Not recommended as a wholesale swap today.

- The thing called "opentelemetry-browser" is the repo `open-telemetry/opentelemetry-browser`,
  which publishes two npm packages: `@opentelemetry/browser-sdk` (0.4.0) and
  `@opentelemetry/browser-instrumentation` (0.8.1). Both are marked **experimental** and the SDK
  README says new releases "may include breaking changes" [S1][S2][S4].
- Every capability asked about exists and plugs into the new SDK: web vitals, browser resource
  attributes, `session.id`, and global exception capture. But web vitals and exceptions are
  emitted as **log records (events)**, not spans. The current Honeycomb SDK emits them as
  **spans** with a much richer attribute set [S6][S11][S23][S24].
- Version alignment is the main practical cost. `@opentelemetry/browser-sdk` 0.4.0 requires
  `@opentelemetry/core`/`resources`/`sdk-trace` `^2.11.0` and `*-0.222.0` experimental packages
  [S3]. The frontend pins `sdk-trace-web 2.2.0`, `instrumentation 0.208.0`,
  `auto-instrumentations-web 0.49.1` and the lockfile has `@honeycombio/opentelemetry-web 1.3.0`
  [R1][R2]. Everything browser-side must move to the 2.11 / 0.222 line together.
- The pragmatic path is **not** to migrate now. `@honeycombio/opentelemetry-web` 1.5.1 already
  depends on `@opentelemetry/browser-instrumentation ^0.6.0` and imports its navigation-timing
  and resource-timing instrumentations [S9][S10]. Upgrading the Honeycomb SDK from 1.3.0 to
  1.5.1 gets the new event-based instrumentations without losing Honeycomb-specific spans.
  Adopt `@opentelemetry/browser-sdk` directly only when it is no longer experimental, or when a
  vendor-neutral demo setup is the explicit goal.

## 1. What `opentelemetry-browser` is

| Item | Finding | Source |
| --- | --- | --- |
| Repo | `github.com/open-telemetry/opentelemetry-browser`, description "OpenTelemetry Browser SDK and instrumentation", last push 2026-09-14, not archived | [S1] |
| README self-description | "the home of OpenTelemetry Browser instrumentations and the future home of the OpenTelemetry Browser SDK" | [S2] |
| Packages in repo | `packages/sdk` and `packages/instrumentation` | [S1] |
| npm: SDK | `@opentelemetry/browser-sdk` 0.4.0, published 2026-09-09; versions 0.1.0, 0.3.0, 0.4.0 | [S3] |
| npm: instrumentation | `@opentelemetry/browser-instrumentation` 0.8.1, published 2026-09-09; 11 releases since 0.1.0 | [S5] |
| Status | SDK README: "This is an experimental package under active development. New releases may include breaking changes." Root README status table lists `browser-instrumentation` as "experimental". | [S4][S2] |
| Signals | "logs and traces. Metrics are out of the scope for now" | [S4] |
| Module format | `"type": "module"`, `exports` map with subpaths `.`, `./logs`, `./traces`, `./document`, `./session`; `sideEffects: false`. README: "assumes you have a bundler in your tool chain that can handle ESM modules." | [S3][S4] |
| Maintainers | Includes Wolfgang Therrien (Honeycomb), Martin Kuba (Grafana), David Luna (Elastic), two from Embrace | [S2] |

### What the SDK bundles

Dependencies of `@opentelemetry/browser-sdk` 0.4.0 [S3]:

```
@opentelemetry/api-logs ^0.222.0
@opentelemetry/core ^2.11.0
@opentelemetry/exporter-logs-otlp-http ^0.222.0
@opentelemetry/exporter-trace-otlp-http ^0.222.0
@opentelemetry/instrumentation ^0.222.0
@opentelemetry/resources ^2.11.0
@opentelemetry/sdk-logs ^0.222.0
@opentelemetry/sdk-trace ^2.11.0
peer: @opentelemetry/api ^1.9.1
```

Notable: it depends on the new `@opentelemetry/sdk-trace` (2.11.0, "OpenTelemetry Tracing"),
**not** `@opentelemetry/sdk-trace-web` [S3][S7]. `startTracesSdk` constructs
`new TracerProvider(...)` from `@opentelemetry/sdk-trace`, sets it global, then sets a global
`CompositePropagator` and a context manager [S6, lines 82-98]. The default context manager is a
minimal stack-based one defined inside the SDK, not `StackContextManager` from `sdk-trace-web`
and not Zone [S8]. Default propagators are `W3CTraceContextPropagator` and
`W3CBaggagePropagator` [S8b].

### Configuration surface

From the SDK README [S4] and `startTracesSdk.ts` [S6]:

- `quickStartBrowserSdk({ serviceName, exportUrl, exportHeaders, disabled, logLevel })`
- `startBrowserSdk({ serviceName, serviceVersion, resourceAttributes, exportConfig, instrumentations, logs: {...}, traces: {...} })`
- Per-signal `startLogsSdk` / `startTracesSdk` under subpaths for tree shaking.
- Traces config accepts `processors` (span processors; if set, no default `BatchSpanProcessor`
  is created unless `exportConfig` is also set), `spanLimits`, `sampler`, `contextManager`,
  `propagators`, `batchProcessorConfig`, `exportConfig.url` (full URL, signal path not appended).
- `instrumentations` are registered via `registerInstrumentations` after global providers are set
  and deregistered on `shutdown()` [S6, lines 100-113].
- Resource: `defaultResource().merge(resourceFromAttributes(...))`. The SDK does **not** run
  resource detectors; `core/sdk.ts` carries a TODO "accept resource detectors?" [S6, lines 35-45][S8c].
- Sessions: `@opentelemetry/browser-sdk/session` exports `createSessionManager`,
  `createLocalStorageSessionStore`, `createDefaultSessionIdGenerator`,
  `createSessionSpanProcessor`, `createSessionLogRecordProcessor`, plus observer hooks [S4].
- Document: `@opentelemetry/browser-sdk/document` has a `DocumentSpanProcessor` that stamps
  `browser.document.url.full` on each span [S8d].

## 2. Browser instrumentation coverage

### 2a. Core Web Vitals (LCP, CLS, INP, TTFB, FCP)

| Option | What it emits | Integrates with browser-sdk? | Source |
| --- | --- | --- | --- |
| `@opentelemetry/browser-instrumentation/experimental/web-vitals` (0.8.1) | One **log record** per metric with `eventName: 'browser.web_vital'` and attributes `browser.web_vital.{name,value,delta,rating,id,navigation_type}`; uses `web-vitals/attribution` `onCLS/onINP/onLCP/onFCP/onTTFB`; optional `includeRawAttribution` puts the JSON attribution in the body | Yes, pass to `instrumentations`; needs the logs signal | [S11][S12] |
| `@honeycombio/opentelemetry-web` `WebVitalsInstrumentation` (1.5.1) | One **span** per metric (`tracer.startSpan`) with start/end times derived from the vital, plus dozens of Honeycomb attribute names (`lcp.*`, `cls.*`, `inp.*`, `fcp.*`, `ttfb.*`) including element/attribution details; INP also creates child spans for long-animation-frame scripts | It is a standard `Instrumentation` object, so it can be registered with any provider, but it is coupled to the Honeycomb SDK build | [S23] |
| `opentelemetry-js-contrib` | No web-vitals instrumentation is listed in the root README package tables | n/a | [S2] |

Semconv status: the `browser.web_vital` event and all `browser.web_vital.*` attributes are
**Development** status [S14][S15]. Values for `name` are `cls`, `fcp`, `inp`, `lcp`, `ttfb`.

### 2b. Browser attributes (`browser.*`, `user_agent.*`, screen)

| Option | Attributes | Integrates? | Source |
| --- | --- | --- | --- |
| `@opentelemetry/opentelemetry-browser-detector` (0.222.0, experimental) | Resource: `user_agent.original`, `browser.language`; and only when `navigator.userAgentData` exists: `browser.platform`, `browser.brands`, `browser.mobile` | Yes, but manually: run `detectResources({detectors:[browserDetector]})` and pass the merged attributes via `resourceAttributes`, since the SDK runs no detectors. The repo's `with-tracing` example does exactly this | [S16][S17][S6][S13] |
| `@opentelemetry/browser-sdk/document` | Span attribute `browser.document.url.full` | Yes, add `DocumentSpanProcessor` to `traces.processors` | [S8d] |
| `@honeycombio/opentelemetry-web` | Resource: `browser.name`, `browser.version`, `browser.touch_screen_enabled`, `device.type`, `network.effectiveType`, `screen.width/height/size`, `entry_page.*`, `honeycomb.distro.*` via `ua-parser-js`. Per-span (`BrowserAttributesSpanProcessor`): `browser.width`, `browser.height`, `browser.page.visibility`, `page.url/route/hash/hostname/search`, `url.path` | Custom code, not part of upstream | [S25][S26][S27] |

Semconv status: `browser.brands`, `browser.language`, `browser.mobile`, `browser.platform`,
`browser.document.url.full` are all **Development** [S14]. `browser.name`, `browser.version`,
`screen.*`, `page.*`, `device.type`, `browser.width/height` used by Honeycomb are **not** in the
semconv browser registry [S14]; they are Honeycomb-defined names [S27].

### 2c. `session.id` management

| Option | Behavior | Integrates? | Source |
| --- | --- | --- | --- |
| `@opentelemetry/browser-sdk/session` | Session manager with LocalStorage store, id generator, `maxDuration`, `inactivityTimeout`, observers; `createSessionSpanProcessor(provider)` and `createSessionLogRecordProcessor(provider)` accept anything with `getSessionId()` | Yes, first-party. Processors must be placed **before** the exporting processor | [S4] |
| `@opentelemetry/web-common` (0.222.0, experimental) | Same API (`SessionManager`, `LocalStorageSessionStore`, `createSessionSpanProcessor`, ...) living in `opentelemetry-js/experimental` | Yes, same structural interfaces; the browser-sdk copy appears to supersede it for SDK users | [S18][S19] |
| `@honeycombio/opentelemetry-web` | `sessionProvider.getSessionId()`; default is a random trace id generated once per page load (not persisted) | Current repo passes `SessionGateway.getSession().userId` as the id | [S28][R3][R4] |
| Repo `SessionIdProcessor.ts` (unused by the Honeycomb path) | Sets `AttributeNames.SESSION_ID` to `userId` in `onStart` | Structurally identical to `createSessionSpanProcessor({getSessionId})` | [R5] |

Semconv status: `session.id` and `session.previous_id` are **Development**, requirement level
Opt-In; `session.start`/`session.end` events are defined [S20][S21].

### 2d. Exception and error handling

| Option | Emits | Integrates? | Source |
| --- | --- | --- | --- |
| `@opentelemetry/browser-instrumentation/experimental/errors` (0.8.1) | Log record `eventName: 'exception'`, `severityNumber: ERROR`, attributes `exception.type/message/stacktrace`; listens to `window` `error` and `unhandledrejection`; `applyCustomAttributes(error)` hook | Yes, needs logs signal | [S24][S11] |
| `@opentelemetry/instrumentation-web-exception` (contrib, 0.15.0, experimental) | Same shape (`exception.*` on a log record), owners include Honeycomb staff | Yes; same API | [S22] |
| `@honeycombio/opentelemetry-web` `GlobalErrorsInstrumentation` | A **span** named `exception` with `exception.*` plus `exception.structured_stacktrace.{columns,lines,functions,urls}` via `tracekit` | Honeycomb-specific | [S29] |
| Repo `recordException.ts` / `SpanUtils.ts` | `span.recordException(error)` and `span.setStatus(ERROR)` on manually created spans in `tracedQuery`/`tracedMutation`; used by Currency and Ad providers | Pure `@opentelemetry/api`; unaffected by SDK choice | [R6][R7][R8] |

Semconv: exceptions-as-logs is **Stable** and is the recommended direction. Instrumentations
that record exceptions as span events "SHOULD introduce an environment variable
`OTEL_SEMCONV_EXCEPTION_SIGNAL_OPT_IN`" with `logs` / `logs/dup` values for phased rollout [S30].

### Span-based instrumentations still needed

The browser-sdk does not replace `fetch`, XHR, document-load or user-interaction span
instrumentation. The root README lists those as span-based packages in `opentelemetry-js` and
`opentelemetry-js-contrib` and the `with-tracing` example registers `FetchInstrumentation` and
`XMLHttpRequestInstrumentation` alongside the event-based ones [S2][S13].
`@opentelemetry/browser-instrumentation` 0.8.1 also ships its own experimental `fetch` and `xhr`
span instrumentations with `http.request.method`, `url.full`, `server.address`, etc. [S11].
Latest contrib versions: `auto-instrumentations-web` 0.67.0, `instrumentation-document-load`
0.67.0, `instrumentation-user-interaction` 0.66.0 (peer `zone.js`) [S31].

## 3. Can each piece plug into `@opentelemetry/browser-sdk`?

**API compatibility.** Yes. The SDK takes any `Instrumentation` from
`@opentelemetry/instrumentation` and any `SpanProcessor` / `LogRecordProcessor` [S6][S4]. The
`with-tracing` example combines browser-sdk session processors with `WebTracerProvider` from
`sdk-trace-web`, `browserDetector`, and contrib span instrumentations in one setup [S13].

**Version alignment.** This is the real constraint.

| Package | Frontend today [R1] | Required by browser-sdk 0.4.0 [S3] | Latest [S31] |
| --- | --- | --- | --- |
| `@opentelemetry/api` | 1.9.0 | `^1.9.1` (peer) | 1.9.x |
| `@opentelemetry/core`, `resources`, `sdk-trace-base`, `sdk-trace-web`, `context-zone` | 2.2.0 | `^2.11.0` (core, resources, sdk-trace) | 2.11.0 |
| `@opentelemetry/instrumentation`, `exporter-trace-otlp-http`, `opentelemetry-browser-detector` | 0.208.0 | `^0.222.0` | 0.222.0 |
| `@opentelemetry/auto-instrumentations-web` | 0.49.1 | n/a (pulls its own `instrumentation`) | 0.67.0 |
| `@honeycombio/opentelemetry-web` | `^1.3.0` (lock: 1.3.0) [R2] | n/a | 1.5.1 (deps `~2.9.0` / `~0.220.0`) [S9] |

Consequences:

- `@opentelemetry/api` 1.9.0 does not satisfy the `^1.9.1` peer range; bump to 1.9.1 [S3].
- Mixing `sdk-trace-base 2.2.0` types with `sdk-trace 2.11.0` will produce duplicate copies in
  the client bundle and possible TypeScript interface mismatches for `SpanProcessor`. Move all
  browser OTel packages to 2.11 / 0.222 in one change.
- The Node-side packages in the same `package.json` (`sdk-node 0.208.0`,
  `auto-instrumentations-node 0.67.0`) share `@opentelemetry/core` and `resources` with the
  browser side. Bumping those to 2.11 to satisfy browser-sdk would touch the server bundle's
  dependency tree even though the server code is out of scope. **[unverified]** whether
  `sdk-node 0.208.0` tolerates `core 2.11.0`; check its peer ranges before bumping.

**ESM and bundling.** Both new packages are `"type": "module"` with `exports` subpaths only
[S3][S11b]. Next.js 16 uses Turbopack as the default bundler and lists ESM ("Static and dynamic
`import` are fully supported") and CommonJS as supported; the frontend's `next.config.js`
already sets `turbopack.root` [S32][R9]. The browser-sdk README says it assumes an ESM-capable
bundler [S4]. The web-vitals instrumentation imports `package.json` with
`with { type: 'json' }` [S12, line 19]; Turbopack lists JSON imports as supported [S32].
**[unverified]** that the `--webpack` fallback path in `next.config.js` handles the import
attribute syntax.

**Transport.** The Honeycomb tracer today posts to `${window.location.origin}/otlp-http/v1/traces`
[R3]. Envoy forwards `/otlp-http/` to the collector with the prefix stripped [R10], and the local
collector config has a `logs` pipeline [R11], so adding `/otlp-http/v1/logs` for the new
event-based instrumentations needs no proxy or collector change. **[unverified]** whether the
production collector values under `deploy/config-files/collector/` route browser log records
to the same Honeycomb dataset as the frontend spans.

## 4. Feasibility assessment

### What would be replaced

| Current (Honeycomb SDK path, `HoneycombFrontendTracer.ts`) | Replacement |
| --- | --- |
| `new HoneycombWebSDK({...}).start()` | `startBrowserSdk({...})` or `startTracesSdk` + `startLogsSdk` |
| `contextManager: new ZoneContextManager()` | `traces.contextManager: new ZoneContextManager()` (2.11) |
| `textMapPropagator: CompositePropagator(W3C baggage + trace context)` | Default propagators are the same two; can omit |
| `getWebAutoInstrumentations({...})` (document-load, fetch, XHR, user-interaction) | Same call, `auto-instrumentations-web 0.67.0`, passed to `instrumentations` |
| Honeycomb `WebVitalsInstrumentation` (spans) | `WebVitalsInstrumentation` from browser-instrumentation (log records) |
| Honeycomb `GlobalErrorsInstrumentation` (spans) | `ErrorsInstrumentation` from browser-instrumentation (log records) |
| `sessionProvider: { getSessionId: () => sessionId }` | `createSessionSpanProcessor({ getSessionId })` and `createSessionLogRecordProcessor({...})` |
| Honeycomb browser resource + `BrowserAttributesSpanProcessor` | `browserDetector` resource + `DocumentSpanProcessor`; rest must be hand-written |
| `sdk.forceFlush()` on `visibilitychange` | No `forceFlush` on the `WebSdk` return type (only `shutdown`) [S6]; keep a reference to the `BatchSpanProcessor` yourself or call `tracerProvider.forceFlush()` via the global provider |

### What would be lost

1. Web-vital **spans** with timing and attribution attributes (`lcp.element`, `cls.*`, `inp.*`
   child spans). Upstream emits one event per vital with six semconv attributes; attribution is
   only available as a JSON body when `includeRawAttribution` is on [S11][S12][S23].
2. `exception` **spans** with `exception.structured_stacktrace.*` columns [S29]. Upstream emits
   log records with a raw `exception.stacktrace` string [S24].
3. Honeycomb resource and span attributes: `browser.name/version`, `device.type`, `screen.*`,
   `entry_page.*`, `browser.width/height`, `browser.page.visibility`, `page.*`, `url.path` [S25][S26][S27].
   Any Honeycomb boards or derived columns keyed on these names break. **[unverified]** whether
   Honeycomb's Frontend Observability UI features depend on the Honeycomb-SDK attribute names
   rather than semconv `browser.web_vital.*`.
4. Honeycomb's `skipOptionsValidation`, deterministic sampler, debug/console-trace-link exporter,
   and `honeycomb.distro.version` stamping [S10].
5. Stability: moving from a 1.x package to two 0.x experimental packages that state breaking
   changes may land in any release [S4].

### Version conflicts

Covered in section 3. Short form: bump every browser OTel package to 2.11 / 0.222, bump `api`
to 1.9.1, and either drop `@honeycombio/opentelemetry-web` or accept two SDK stacks in the
bundle.

### Verdict

Feasible with caveats. The API surface fits and the four capabilities exist. The costs are a
coordinated version bump, a signal change (spans to log events) for vitals and errors that
affects existing Honeycomb queries, loss of Honeycomb-specific attributes, and adopting
experimental packages. Recommended sequencing:

1. **Now:** upgrade `@honeycombio/opentelemetry-web` 1.3.0 to 1.5.1. It already carries
   `@opentelemetry/browser-instrumentation` for navigation and resource timing [S9][S10], and
   moves the browser stack to 2.9 / 0.220, which shrinks the later gap.
2. **Later, if vendor-neutral is the goal:** do the browser-sdk migration below, once
   `@opentelemetry/browser-sdk` publishes a non-experimental release or Honeycomb's SDK itself
   rebases on it.

## Migration outline (if proceeding)

1. Create a feature branch. Bump browser packages in `src/frontend/package.json`:
   `@opentelemetry/api 1.9.1`, `core`/`resources`/`sdk-trace-web`/`context-zone`/`sdk-trace-base`
   to 2.11.0, `instrumentation`/`exporter-trace-otlp-http`/`opentelemetry-browser-detector` to
   0.222.0, `auto-instrumentations-web` to 0.67.0. Add `@opentelemetry/browser-sdk 0.4.0`,
   `@opentelemetry/browser-instrumentation 0.8.1`, `@opentelemetry/sdk-trace 2.11.0`,
   `@opentelemetry/sdk-logs 0.222.0`, `@opentelemetry/api-logs 0.222.0`. Check `sdk-node 0.208.0`
   peer ranges against `core 2.11.0` before touching Node-side pins [S3][S31].
2. Write a new client tracer module (keep `HoneycombFrontendTracer.ts` until parity is proven):
   - Build resource attributes: `service.name` from `window.ENV`, merged with
     `detectResources({detectors:[browserDetector]}).attributes` [S16][S13].
   - `createSessionSpanProcessor({ getSessionId: () => userId })` and the log-record twin,
     placed first in `traces.processors` / `logs.processors`, followed by a `BatchSpanProcessor`
     over `OTLPTraceExporter({ url: origin + '/otlp-http/v1/traces' })` and the logs equivalent
     at `/v1/logs` [S4][S6][R10].
   - Add `DocumentSpanProcessor` for `browser.document.url.full` [S8d].
   - `traces.contextManager: new ZoneContextManager()`; keep `propagateTraceHeaderCorsUrls`
     and the `app.synthetic_request` hook in the fetch config [R3].
   - `instrumentations`: `getWebAutoInstrumentations({...})`, `new WebVitalsInstrumentation()`,
     `new ErrorsInstrumentation()`, optionally `NavigationInstrumentation`,
     `NavigationTimingInstrumentation`, `ResourceTimingInstrumentation`, `UserActionInstrumentation` [S11].
3. Port the attributes the demo's boards rely on. Re-implement a small span processor for
   `browser.width/height`, `page.*`, `url.path` and add `screen.*`/`device.type` resource
   attributes if queries use them [S26][S27]. Or accept the semconv-only set and update queries.
4. Replace the `visibilitychange` flush with `trace.getTracerProvider()` cast to the SDK
   provider and `forceFlush()`, or hold the processor reference [S6].
5. Update Honeycomb queries and boards: web vitals move from spans named by vital to log
   records with `name = browser.web_vital` and `browser.web_vital.name in (lcp, cls, inp, fcp, ttfb)`;
   errors move from `exception` spans to `exception` log records [S12][S24].
6. Verify with the loadgen and Cypress flows, then remove `@honeycombio/opentelemetry-web`,
   `FrontendTracer.ts`, and `SessionIdProcessor.ts`.

## Sources

Upstream OpenTelemetry (browser repo, JS, contrib, semconv):

- [S1] GitHub API `repos/open-telemetry/opentelemetry-browser` (description, pushed_at 2026-09-14, `packages/` tree, releases `browser-sdk-v0.4.0` and `browser-instrumentation-v0.8.1` on 2026-09-09). https://github.com/open-telemetry/opentelemetry-browser
- [S2] Root README, "About", "Browser Packages" tables, "Maintainers". https://github.com/open-telemetry/opentelemetry-browser/blob/main/README.md
- [S3] npm registry metadata for `@opentelemetry/browser-sdk` 0.4.0 (`npm view`; dependencies, peerDependencies, versions, time.modified 2026-09-09) and `packages/sdk/package.json` (`type`, `exports`, `sideEffects`). https://www.npmjs.com/package/@opentelemetry/browser-sdk ; https://github.com/open-telemetry/opentelemetry-browser/blob/main/packages/sdk/package.json
- [S4] SDK README (experimental note, ESM bundler note, config reference, Sessions section). https://github.com/open-telemetry/opentelemetry-browser/blob/main/packages/sdk/README.md
- [S5] npm registry metadata for `@opentelemetry/browser-instrumentation` 0.8.1 (`npm view`). https://www.npmjs.com/package/@opentelemetry/browser-instrumentation
- [S6] `packages/sdk/src/traces/startTracesSdk.ts` (resource lines 35-45, processors 49-76, `TracerProvider` from `@opentelemetry/sdk-trace` lines 82-88, context manager 93-96, instrumentations 100-113, return type with `shutdown` only). https://github.com/open-telemetry/opentelemetry-browser/blob/main/packages/sdk/src/traces/startTracesSdk.ts
- [S7] npm `@opentelemetry/sdk-trace` 2.11.0 and its README ("does not provide automated instrumentation ... context propagation"). https://github.com/open-telemetry/opentelemetry-js/blob/main/packages/sdk-trace/README.md
- [S8] `packages/sdk/src/core/context.ts` (`getDefaultContextManager`, stack-based). https://github.com/open-telemetry/opentelemetry-browser/blob/main/packages/sdk/src/core/context.ts
- [S8b] `packages/sdk/src/core/propagation.ts` line 19 (`W3CTraceContextPropagator`, `W3CBaggagePropagator`). https://github.com/open-telemetry/opentelemetry-browser/blob/main/packages/sdk/src/core/propagation.ts
- [S8c] `packages/sdk/src/core/sdk.ts` lines 66-67 (TODO "accept resource detectors?"). https://github.com/open-telemetry/opentelemetry-browser/blob/main/packages/sdk/src/core/sdk.ts
- [S8d] `packages/sdk/src/document/DocumentSpanProcessor.ts` line 43 and `document/semconv.ts` (`browser.document.url.full`). https://github.com/open-telemetry/opentelemetry-browser/tree/main/packages/sdk/src/document
- [S9] npm registry metadata for `@honeycombio/opentelemetry-web` 1.5.1 (`npm view`; deps include `@opentelemetry/browser-instrumentation ^0.6.0`, `sdk-trace-web ~2.9.0`, `instrumentation ~0.220.0`, `web-common ~0.220.0`; modified 2026-09-15). https://www.npmjs.com/package/@honeycombio/opentelemetry-web
- [S10] `honeycomb-otel-sdk.ts` imports lines 6-9 (`WebVitalsInstrumentation`, `GlobalErrorsInstrumentation`, `NavigationTimingInstrumentation` and `ResourceTimingInstrumentation` from `@opentelemetry/browser-instrumentation`) and CHANGELOG v1.4.0 / v1.5.0 / v1.5.1. https://github.com/honeycombio/honeycomb-opentelemetry-web/blob/main/packages/honeycomb-opentelemetry-web/src/honeycomb-otel-sdk.ts ; https://github.com/honeycombio/honeycomb-opentelemetry-web/blob/main/packages/honeycomb-opentelemetry-web/CHANGELOG.md
- [S11] `packages/instrumentation/README.md` (Web Vitals, Errors, Fetch, XHR, Navigation, User Action sections and option tables). https://github.com/open-telemetry/opentelemetry-browser/blob/main/packages/instrumentation/README.md
- [S11b] `packages/instrumentation/package.json` (`type: module`, `exports` under `./experimental/*`, deps `web-vitals ^6.2.1`, `semantic-conventions ^1.43.0`, peer `api ^1.9.1`). https://github.com/open-telemetry/opentelemetry-browser/blob/main/packages/instrumentation/package.json
- [S12] `packages/instrumentation/src/web-vitals/instrumentation.ts` (line 18 `web-vitals/attribution`, line 19 JSON import attribute, lines 81-85 `onCLS/onINP/onLCP/onFCP/onTTFB`, lines 120-158 `_emitWebVital` -> `logger.emit`) and `web-vitals/semconv.ts` (`browser.web_vital`, `browser.web_vital.*`). https://github.com/open-telemetry/opentelemetry-browser/tree/main/packages/instrumentation/src/web-vitals
- [S13] `examples/with-tracing/src/main.ts` and its `package.json` (combines `browserDetector`, `@opentelemetry/browser-sdk/session`, `WebTracerProvider`, `FetchInstrumentation`, `XMLHttpRequestInstrumentation`, event-based instrumentations). https://github.com/open-telemetry/opentelemetry-browser/tree/main/examples/with-tracing
- [S14] Semconv browser attribute registry (all `browser.*` attributes Development). https://github.com/open-telemetry/semantic-conventions/blob/main/docs/registry/attributes/browser.md
- [S15] Semconv browser events (`browser.web_vital` event, Development). https://github.com/open-telemetry/semantic-conventions/blob/main/docs/browser/browser-events.md
- [S16] `experimental/packages/opentelemetry-browser-detector/src/BrowserDetector.ts` (`getBrowserAttributes`). https://github.com/open-telemetry/opentelemetry-js/blob/main/experimental/packages/opentelemetry-browser-detector/src/BrowserDetector.ts
- [S17] Browser detector README (experimental note; attributes present only with `userAgentData`). https://github.com/open-telemetry/opentelemetry-js/blob/main/experimental/packages/opentelemetry-browser-detector/README.md
- [S18] `experimental/packages/web-common/README.md` (Sessions API). https://github.com/open-telemetry/opentelemetry-js/blob/main/experimental/packages/web-common/README.md
- [S19] npm `@opentelemetry/web-common` 0.222.0 (`npm view`; deps `sdk-logs 0.222.0`, `sdk-trace 2.11.0`). https://www.npmjs.com/package/@opentelemetry/web-common
- [S20] Semconv session attribute registry. https://github.com/open-telemetry/semantic-conventions/blob/main/docs/registry/attributes/session.md
- [S21] Semconv general session conventions (`session.start`, `session.end`). https://github.com/open-telemetry/semantic-conventions/blob/main/docs/general/session.md
- [S22] `packages/instrumentation-web-exception/README.md` and `package.json` (0.15.0; owners @martinkuba @wolfgangcodes @pkanal). https://github.com/open-telemetry/opentelemetry-js-contrib/tree/main/packages/instrumentation-web-exception
- [S23] Honeycomb `web-vitals-autoinstrumentation.ts` (line 19 `web-vitals/attribution`, class at 335, `tracer.startSpan` at 541/602/663/733, INP child spans at 451-474, attribute constants lines 37-85). https://github.com/honeycombio/honeycomb-opentelemetry-web/blob/main/packages/honeycomb-opentelemetry-web/src/web-vitals-autoinstrumentation.ts
- [S24] `packages/instrumentation/src/errors/instrumentation.ts` (line 21 `EXCEPTION_EVENT_NAME = 'exception'`, lines 47-48 listeners, 111-128 attributes, severity, `logger.emit`). https://github.com/open-telemetry/opentelemetry-browser/blob/main/packages/instrumentation/src/errors/instrumentation.ts
- [S25] Honeycomb `configure-resource-attributes.ts` and `browser-attributes-resource.ts` (ua-parser-js, screen size, network type, device type). https://github.com/honeycombio/honeycomb-opentelemetry-web/tree/main/packages/honeycomb-opentelemetry-web/src
- [S26] Honeycomb `browser-attributes-span-processor.ts` (`onStart` sets `browser.width/height`, `page.*`, `url.path`, `browser.page.visibility`). https://github.com/honeycombio/honeycomb-opentelemetry-web/blob/main/packages/honeycomb-opentelemetry-web/src/browser-attributes-span-processor.ts
- [S27] Honeycomb `semantic-attributes.ts` (attribute name constants). https://github.com/honeycombio/honeycomb-opentelemetry-web/blob/main/packages/honeycomb-opentelemetry-web/src/semantic-attributes.ts
- [S28] Honeycomb `default-session-provider.ts` (`RandomIdGenerator().generateTraceId()` once per load). https://github.com/honeycombio/honeycomb-opentelemetry-web/blob/main/packages/honeycomb-opentelemetry-web/src/default-session-provider.ts
- [S29] Honeycomb `global-errors-autoinstrumentation.ts` (tracekit line 17, `exception.structured_stacktrace.*` lines 58-61, `tracer.startSpan('exception')` lines 89-90, listeners 163-164). https://github.com/honeycombio/honeycomb-opentelemetry-web/blob/main/packages/honeycomb-opentelemetry-web/src/global-errors-autoinstrumentation.ts
- [S30] Semconv exceptions in logs (Stable; `OTEL_SEMCONV_EXCEPTION_SIGNAL_OPT_IN`). https://github.com/open-telemetry/semantic-conventions/blob/main/docs/exceptions/exceptions-logs.md
- [S31] npm `npm view` results on 2026-09-16: `auto-instrumentations-web` 0.67.0, `sdk-trace-web` 2.11.0, `opentelemetry-browser-detector` 0.222.0, `instrumentation` 0.222.0, `exporter-trace-otlp-http` 0.222.0, `context-zone` 2.11.0, `sdk-logs` 0.222.0, `exporter-logs-otlp-http` 0.222.0, `api-logs` 0.222.0, `instrumentation-document-load` 0.67.0, `instrumentation-user-interaction` 0.66.0 (peer `zone.js`), `instrumentation-fetch` 0.222.0, `instrumentation-web-exception` 0.15.0, `instrumentation-browser-navigation` 0.15.0.
- [S32] Next.js docs, Turbopack ("Turbopack is now the default bundler in Next.js", ESM and CommonJS "Supported", JSON imports "Supported", v16.0.0 version note). https://nextjs.org/docs/app/api-reference/turbopack

Repo files read (no edits):

- [R1] `src/frontend/package.json` (dependency pins).
- [R2] `src/frontend/package-lock.json` line 705-707 (`@honeycombio/opentelemetry-web` resolved 1.3.0).
- [R3] `src/frontend/utils/telemetry/HoneycombFrontendTracer.ts` (endpoint line 37, `skipOptionsValidation` 39, instrumentations 45-63, `sessionProvider` 64-66, `visibilitychange` flush 86-90).
- [R4] `src/frontend/pages/_app.tsx` lines 37-40 (`HoneycombFrontendTracer(session.userId)`) and `src/frontend/gateways/Session.gateway.ts` (uuid v4 `userId` in `sessionStorage`).
- [R5] `src/frontend/utils/telemetry/SessionIdProcessor.ts`.
- [R6] `src/frontend/utils/telemetry/recordException.ts`.
- [R7] `src/frontend/utils/telemetry/SpanUtils.ts`.
- [R8] `src/frontend/providers/Currency.provider.tsx` line 35, `src/frontend/providers/Ad.provider.tsx` lines 37, 47 (`tracedQuery` callers).
- [R9] `src/frontend/next.config.js` (`turbopack.root`, webpack fallback block).
- [R10] `src/frontend-proxy/envoy.tmpl.yaml` lines 44-45 (`/otlp-http/` -> `opentelemetry_collector_http`, `prefix_rewrite: "/"`).
- [R11] `skaffold-config/demo-values.yaml` lines 403-415 (collector `pipelines:` includes `logs:`).
- `src/frontend/utils/telemetry/FrontendTracer.ts` (upstream-style tracer, read for context; not wired in `_app.tsx`).
