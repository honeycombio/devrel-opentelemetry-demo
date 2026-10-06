# Research: a boot-time flag to choose the frontend browser SDK

Date: 2026-09-18. Scope: browser-side telemetry in `src/frontend` only. Path A is the latest
`@honeycombio/opentelemetry-web`; path B is upstream `@opentelemetry/browser-sdk` plus
`@opentelemetry/browser-instrumentation`. Both must ship in one build and be chosen by a flag at boot.
The Node SDK (`src/frontend/utils/telemetry/Instrumentation.js`) stays on upstream opentelemetry-js and
is out of scope. What each SDK does and what would be lost by swapping is covered in the sibling note
[prior]; this note does not repeat it.

All claims cite primary sources. Items marked **[unverified]** could not be confirmed.

## Summary and recommendation

- **Both SDKs can live in one `package.json` and one client bundle**, but not on a single copy of
  `@opentelemetry/core`, `resources`, `sdk-trace*` or `instrumentation`. Honeycomb 1.5.1 pins
  `~2.9.0` / `~0.220.0`; browser-sdk 0.4.0 needs `^2.11.0` / `^0.222.0`. npm nests the second copy;
  the client downloads only the chunk for the path selected. `@opentelemetry/api` resolves to one
  copy (1.9.1) for every package, so global registration works [S1][S2][S3].
- **Flag mechanism: runtime `window.ENV` (option a), extended with a per-request cookie override.**
  It is the only option that is same-image, available synchronously before the tracer boots, and
  reachable by Cypress, Playwright and the loadgen without a redeploy. `NEXT_PUBLIC_*` is frozen at
  `next build` [S10]. flagd requires an async provider connection before the first flag value is
  trustworthy [S12], which delays the tracer and loses early fetch spans.
- **Bundle isolation** comes from a literal-path `await import('./tracer-honeycomb')` inside an
  `if`. Turbopack and webpack both split on dynamic `import()` [S11][S13]; `FrontendTracer.ts` line 22
  already does this for `@opentelemetry/context-zone` [R3].
- **Hard requirement for path A**: bump `@opentelemetry/auto-instrumentations-web` from 0.49.1 to
  0.65.x (Honeycomb 1.5.1 peer `^0.65.0`) and `@opentelemetry/api` to 1.9.1 [S1]. Path B needs its own
  `auto-instrumentations-web` 0.67.x, so two versions of that package must be installed via an npm
  alias, or path B must use the fetch/XHR instrumentations from `@opentelemetry/browser-instrumentation`
  instead [S4][S5].
- **Stamp the choice on the resource** as `app.frontend.otel_sdk` = `honeycomb` | `upstream`.
  `telemetry.distro.name` distinguishes the two today, but only because path B leaves it unset [S15][S16].

## 1. Versions on 2026-09-18 (`npm view`)

| Package | Latest | Ranges on shared packages | Source |
| --- | --- | --- | --- |
| `@honeycombio/opentelemetry-web` | 1.5.1 (2026-09-15) | `api ~1.9.1`, `core ~2.9.0`, `resources ~2.9.0`, `sdk-trace-base/web ~2.9.0`, `instrumentation ~0.220.0`, `sdk-logs/api-logs ~0.220.0`, `web-common ~0.220.0`, `browser-instrumentation ^0.6.0`, `browser-detector ~0.220.0`; peers `auto-instrumentations-web ^0.65.0`, `context-zone ^2.0.0` | [S1] |
| `@opentelemetry/browser-sdk` | 0.4.0 (2026-09-09) | `core ^2.11.0`, `resources ^2.11.0`, `sdk-trace ^2.11.0`, `sdk-logs/api-logs ^0.222.0`, `exporter-*-otlp-http ^0.222.0`; peer `api ^1.9.1`. Registry metadata omits `instrumentation`; `packages/sdk/package.json` on main declares `^0.222.0` and the source imports `registerInstrumentations` from it **[unverified]** whether 0.4.0 shipped without the declaration | [S2][S3][S6] |
| `@opentelemetry/browser-instrumentation` | 0.8.1 | `instrumentation ^0.222.0`, `api-logs ^0.222.0`, `semantic-conventions ^1.43.0`, `web-vitals ^6.2.1`; peer `api ^1.9.1` | [S4] |
| `@opentelemetry/auto-instrumentations-web` | 0.67.0 | `instrumentation ^0.222.0`, `instrumentation-fetch/xml-http-request ^0.222.0`, `document-load ^0.67.0`, `user-interaction ^0.66.0`; peers `api ^1.9.0`, `zone.js` | [S5] |
| `@opentelemetry/sdk-trace-web` | 2.11.0 | `core 2.11.0`, `sdk-trace-base 2.11.0` (exact); peer `api >=1.0.0 <1.10.0` | [S7] |
| `@opentelemetry/context-zone` | 2.11.0 | `context-zone-peer-dep 2.11.0`, `zone.js ^0.11 - ^0.16`; peer `api >=1.0.0 <1.10.0` | [S7] |
| `@opentelemetry/core` | 2.11.0 | peer `api >=1.0.0 <1.10.0` | [S7] |
| `@opentelemetry/resources` | 2.11.0 | `core 2.11.0` (exact); peer `api >=1.3.0 <1.10.0` | [S7] |
| `@opentelemetry/api` | 1.9.1 (2026-05-01) | none | [S7] |
| `@opentelemetry/instrumentation` | 0.222.0 | `api-logs 0.222.0`; peer `api ^1.3.0` | [S7] |
| `@opentelemetry/sdk-node` | 0.222.0 | every dep exact-pinned to `2.11.0` / `0.222.0` | [S7] |
| `@opentelemetry/sdk-node` **0.208.0** (repo pin) | | `core 2.2.0`, `resources 2.2.0`, `sdk-trace-base 2.2.0`, `instrumentation 0.208.0` (all exact); peer `api >=1.3.0 <1.10.0` | [S8] |

Ranges that pull the lower line in path A: `auto-instrumentations-web ^0.65.0` resolves to 0.65.x
(`instrumentation ^0.220.0`) and `browser-instrumentation ^0.6.0` resolves to 0.6.x (`core ^2.9.0`,
`instrumentation ^0.220.0`). A caret on a 0.x version pins the minor [S5][S4].

## 2. Can both SDKs coexist in one `package.json` and one client bundle?

| Shared package | Path A wants | Path B wants | Node side (sdk-node 0.208.0) | Result |
| --- | --- | --- | --- | --- |
| `@opentelemetry/api` | `~1.9.1` | `^1.9.1` | `>=1.3.0 <1.10.0` | **One copy, 1.9.1.** Repo pins 1.9.0; bump. |
| `core`, `resources` | `~2.9.0` | `^2.11.0` | `2.2.0` exact | **Three copies.** The lockfile already carries six copies of `core` today [R2], so this is not new. |
| `sdk-trace-base` / `sdk-trace-web` / `sdk-trace` | `~2.9.0` base+web | `^2.11.0` `sdk-trace` | `2.2.0` | Two browser copies; different packages, so no hoist conflict. |
| `instrumentation` | `~0.220.0` | `^0.222.0` | `0.208.0` | **Three copies.** |
| `auto-instrumentations-web` | peer `^0.65.0` | needs 0.67.x for `^0.222.0` | n/a | **Conflict at the top level.** One `package.json` entry cannot satisfy both. |

What breaks and what does not:

- **`@opentelemetry/api` global registration**: no conflict. One `api` copy, and only one SDK boots per
  page load, so one `setGlobalTracerProvider` / `setGlobalContextManager` call [S6].
- **Two `@opentelemetry/instrumentation` copies**: works at runtime. `registerInstrumentations` only
  calls `setTracerProvider`, `setMeterProvider`, `setLoggerProvider`, `enable` on each object, so a
  0.220 instrumentation registered by 0.222 code is fine. TypeScript may reject the mix because
  `InstrumentationBase` has private members; cast at the boundary **[unverified]** that tsc rejects.
- **`SpanProcessor` type mismatch**: browser-sdk's `createSessionSpanProcessor` returns a processor
  typed against `sdk-trace 2.11`; passing it to Honeycomb's `spanProcessors` (typed against
  `sdk-trace-base 2.9`) needs a cast. Runtime shape (`onStart`, `onEnd`, `forceFlush`, `shutdown`) is
  identical [S6][R4].
- **`auto-instrumentations-web`**: install two versions with an alias, e.g.
  `"auto-instrumentations-web-upstream": "npm:@opentelemetry/auto-instrumentations-web@0.67.0"`, or
  drop it on path B and use `FetchInstrumentation`, `XMLHttpRequestInstrumentation` from
  `@opentelemetry/browser-instrumentation` 0.8.1 [S4][prior §2]. Document-load and user-interaction
  have no browser-instrumentation equivalent, so path B loses them without the alias.
- **`sdk-node` 0.208.0**: exact pins on `core 2.2.0` and `resources 2.2.0`. Bumping the root pins to
  2.9 or 2.11 does not break it; npm nests 2.2.0 under `sdk-node`. Its `api` peer accepts 1.9.1. No
  server-side change is forced [S8].

## 3. Flag mechanism options

### a. Runtime `window.ENV` from `_document.tsx` (recommended)

`_document.tsx` reads `process.env` on the server per request and writes a `window.ENV` script before
`NextScript`, so the value exists before `_app.tsx` runs [R5]. `WEB_OTEL_SERVICE_NAME` and
`OTEL_COLLECTOR_HOST` already flow this way; env values come from Helm `envOverrides` under
`components.frontend` in `skaffold-config/demo-values.yaml` (local) and
`deploy/config-files/demo/values.yaml` (prod) [R6][R7]. Adding `WEB_OTEL_SDK` is one line in each
values file plus one line in the `envString`. Same image; switching is a Helm values change and a
pod rollout.

Because `getInitialProps` has the request, it can also honour a cookie or query parameter
(`?otel_sdk=upstream`) and put that into `window.ENV` instead of the env default. That gives every
test client a per-session switch with no redeploy: Cypress `cy.setCookie` before `cy.visit`
[R8]; the loadgen's Playwright users already call `page.route` to add a baggage header and can add
a cookie the same way [R9]; two Locust user classes can run both paths in one soak. The synthetic
baggage entry `synthetic_request` already uses this pattern to pick the OTLP endpoint per request [R5].

### b. `NEXT_PUBLIC_*` build-time env

Next.js inlines `NEXT_PUBLIC_` values "at build time, into the js bundle"; "After being built, your app
will no longer respond to changes to these environment variables ... if you build and deploy a single
Docker image to multiple environments, all `NEXT_PUBLIC_` variables will be frozen" [S10]. Two paths in
one image is impossible with this. The existing `NEXT_PUBLIC_OTEL_SERVICE_NAME` in `next.config.js`
`env` is inlined the same way; the repo works around it with `window.ENV` already [R1][R5].

### c. OpenFeature / flagd

`_app.tsx` calls `OpenFeature.setContext(...)` then `setProvider(new FlagdWebProvider(...))` after
the tracer has booted [R10]. The web SDK evaluates synchronously only "once the provider backend
replies"; it warns "to prevent flag evaluations from defaulting while the provider is initializing ...
evaluate flags only after the provider is ready" via `setProviderAndWait` or the `READY` event [S12].
Boot cost: the tracer would wait for a gRPC-web round trip through Envoy to flagd (retries up to
`maxRetries: 3`, `maxDelay: 10000`). Fetch and XHR made before that (the flagd handshake itself, first
React Query calls) are never patched, so their spans are lost. Document-load survives because the
instrumentation reads Performance API entries after the fact **[unverified]** for the
`readyState === 'complete'` late-registration path. None of the 18 flags in `src/flagd/demo.flagd.json`
is read by frontend code today; `_app.tsx` is the only OpenFeature consumer [R11]. A flag also cannot
change a running page; a reload is needed either way. Keep flagd for demo scenarios, not for SDK boot.

### Recommendation

Option (a) with the cookie/query override. Env var `WEB_OTEL_SDK` with values `honeycomb` (default) and
`upstream`; `_document.tsx` copies it, or the request override, into `window.ENV.OTEL_WEB_SDK`.

## 4. Bundle isolation

- Next.js: "The module is only loaded in the browser after the user types in the search input" for
  `await import('fuse.js')` inside an event handler; the path "must be explicitly written. It can't be a
  template string nor a variable" [S11].
- Turbopack is the default in Next.js 16 and lists ESM "Static and dynamic `import`" as fully
  supported; `turbopackClientSideNestedAsyncChunking` defaults to true for `build` [S13]. The
  `--webpack` fallback in `next.config.js` splits on `import()` as well; the `webpack` block in
  `next.config.js` only sets Node polyfill fallbacks [R1][S13].
- Precedent: `FrontendTracer.ts` line 22 `await import('@opentelemetry/context-zone')` [R3].
- Cost: the tracer boot becomes `async`. Requests issued before the awaited chunk arrives are not
  patched by fetch/XHR instrumentation. Keep the selector module tiny and import it first in `_app.tsx`.
- Honeycomb 1.5.1 "resolve[s] non-browser environments to an inert build" [S9], which makes the
  SSR pass safe even if the module is evaluated on the server; browser-sdk has no such guard, so keep
  it behind the `typeof window` check that `_app.tsx` already has [R10].

## 5. Shared code between the two paths

| Piece | Share? | Note | Source |
| --- | --- | --- | --- |
| `getWebAutoInstrumentations` **config object** | Yes | Plain object; import the function from each path's own `auto-instrumentations-web` version (alias). | [S5] |
| `applyCustomAttributesOnSpan` for `app.synthetic_request` | Yes | Uses only `@opentelemetry/api` `Span`. | [R4] |
| Session id | Yes | `{ getSessionId: () => userId }` satisfies Honeycomb `sessionProvider` and browser-sdk `createSessionSpanProcessor(provider)`; add `createSessionLogRecordProcessor` on B. | [S1][S14] |
| `ZoneContextManager` | Yes | `context-zone` 2.11 satisfies Honeycomb peer `^2.0.0`; browser-sdk `traces.contextManager` takes any api `ContextManager`. | [S1][S6] |
| Propagators | Yes | Both default to W3C trace context + baggage; explicit `CompositePropagator` optional. | [S6] |
| OTLP URLs | Yes | Constants `${origin}/otlp-http/v1/traces` and `/v1/logs`. Honeycomb: set `tracesEndpoint` and `logsEndpoint` explicitly; today `endpoint` is given the full traces URL, so 1.5.x log exports would go to `.../v1/traces/v1/logs`. browser-sdk: `exportConfig.url` is the full URL. | [R4][S9][S14] |
| `visibilitychange` forceFlush | No | Honeycomb `WebSDK.forceFlush()` exists (base-otel-sdk.ts line 261). browser-sdk `WebSdk` return type is `{ shutdown }` only, on main and in 0.4.0; no `forceFlush` anywhere under `packages/sdk/src`. On B, pass `traces.processors` yourself and keep the `BatchSpanProcessor` reference, or cast `trace.getTracerProvider().getDelegate()`. | [S6][S9] |
| `browser.*` resource and page attributes | No | Honeycomb-only; see [prior §4]. | |

## 6. `@honeycombio/opentelemetry-web` changes 1.3.0 to 1.5.1

No entry in the CHANGELOG is marked breaking [S9]. Changes that touch `HoneycombFrontendTracer.ts`:

| Version | Change | Effect on the repo | Source |
| --- | --- | --- | --- |
| 1.3.1 (2026-07-23) | cache width/height on layout change | none | [S9] |
| 1.4.0 (2026-08-25) | Core Web Vitals for soft navigations; `web-vitals` 6 | more web-vital spans per session | [S9] |
| 1.5.0 (2026-09-02) | opt-in `navigationTimingInstrumentationConfig`, `resourceTimingInstrumentationConfig` (both `{ enabled: false }`), emitted as log events via `@opentelemetry/browser-instrumentation` | needs `logsEndpoint` if enabled | [S9][S15] |
| 1.5.1 (2026-09-14) | inert build for non-browser environments | safer SSR import | [S9] |
| deps 1.3.0 to 1.5.1 | `instrumentation ~0.203 -> ~0.220`, `core ^2.0 -> ~2.9`, `api ~1.9.0 -> ~1.9.1`, peer `auto-instrumentations-web ^0.49 -> ^0.65`; new `browser-instrumentation ^0.6.0`, `sdk-logs`, `api-logs` | **must bump** `auto-instrumentations-web` 0.49.1 -> 0.65.x and `api` -> 1.9.1 | [S1][S17] |
| options added | `navigationTimingInstrumentationConfig`, `resourceTimingInstrumentationConfig`, `logExporters`, `logRecordProcessors`, `disableDefaultLogExporter` | optional | [S15] |
| unchanged | `skipOptionsValidation`, `sessionProvider`, `endpoint`/`tracesEndpoint`, `contextManager`, `instrumentations`, exports `WebVitalsInstrumentation`, `GlobalErrorsInstrumentation`, `BaggageSpanProcessor`, `UserInteractionInstrumentation` | none | [S15][S16] |

The README still says "compatible with OpenTelemetry Auto-Instrumentations for Web ~0.49.0"; the
`package.json` peer range is `^0.65.0`. Trust the manifest [S1][S9].

## 7. Telling the two SDKs apart in Honeycomb

Both SDKs start from `defaultResource()`, which sets `telemetry.sdk.name = opentelemetry`,
`telemetry.sdk.language = webjs`, `telemetry.sdk.version = <core version>` [S6][S16][S18]. Honeycomb adds
`telemetry.distro.name = @honeycombio/opentelemetry-web`, `telemetry.distro.version`,
`honeycomb.distro.version`, `honeycomb.distro.runtime_version = browser` [S16]; browser-sdk adds no
distro attributes [S6]. Semconv marks `telemetry.distro.*` Stable and says official distributions
"SHOULD" set them, so do not fake a distro name for path B [S18].

Recommendation: stamp an explicit resource attribute on both paths via `resourceAttributes`:
`app.frontend.otel_sdk` = `honeycomb` | `upstream`, plus `app.frontend.otel_sdk.version`. Queries
`GROUP BY app.frontend.otel_sdk` then work even if Honeycomb's distro attributes change. The
`telemetry.sdk.version` split (2.9.x vs 2.11.0) is a usable fallback but drifts with every bump.

## Sources

- [prior] `docs/research/opentelemetry-browser-migration.md` (2026-09-16), this repo.
- [S1] `npm view @honeycombio/opentelemetry-web` 1.5.1 (dependencies, peerDependencies, `time.modified` 2026-09-15). https://www.npmjs.com/package/@honeycombio/opentelemetry-web
- [S2] `npm view @opentelemetry/browser-sdk` 0.4.0; versions 0.1.0, 0.3.0, 0.4.0. https://www.npmjs.com/package/@opentelemetry/browser-sdk
- [S3] `packages/sdk/package.json` on main (version 0.4.0, declares `@opentelemetry/instrumentation ^0.222.0`). https://github.com/open-telemetry/opentelemetry-browser/blob/main/packages/sdk/package.json
- [S4] `npm view @opentelemetry/browser-instrumentation` 0.8.1 and `@0.6` (0.6.0: `core ^2.9.0`, `instrumentation ^0.220.0`). https://www.npmjs.com/package/@opentelemetry/browser-instrumentation
- [S5] `npm view @opentelemetry/auto-instrumentations-web` 0.67.0, `@0.65` (0.65.0: `instrumentation ^0.220.0`), `@0.49.1` (`instrumentation ^0.203.0`). https://www.npmjs.com/package/@opentelemetry/auto-instrumentations-web
- [S6] `packages/sdk/src/traces/startTracesSdk.ts` (imports lines 6-15; `defaultResource().merge` lines 49-50; global registration lines 85-98; `registerInstrumentations` lines 100-106; return `{ shutdown }` lines 108-113) and `core/types.ts` line 233 (`WebSdk.shutdown` only). https://github.com/open-telemetry/opentelemetry-browser/blob/main/packages/sdk/src/traces/startTracesSdk.ts
- [S7] `npm view` on 2026-09-18: `sdk-trace-web` 2.11.0, `context-zone` 2.11.0, `context-zone-peer-dep` 2.11.0, `core` 2.11.0, `resources` 2.11.0, `api` 1.9.1, `instrumentation` 0.222.0, `sdk-node` 0.222.0, `web-common` 0.222.0, `sdk-trace` 2.11.0, `sdk-logs` 0.222.0, `api-logs` 0.222.0, `sdk-trace-base` 2.11.0, `exporter-trace-otlp-http` 0.222.0.
- [S8] `npm view @opentelemetry/sdk-node@0.208.0` (exact pins `core 2.2.0`, `resources 2.2.0`, `instrumentation 0.208.0`; peer `api >=1.3.0 <1.10.0`).
- [S9] Honeycomb CHANGELOG v1.3.1 to v1.5.1, README config table, `base-otel-sdk.ts` lines 97-104 (`defaultResource()`), 261 (`forceFlush`), 280 (`shutdown`). https://github.com/honeycombio/honeycomb-opentelemetry-web/blob/main/packages/honeycomb-opentelemetry-web/CHANGELOG.md ; https://github.com/honeycombio/honeycomb-opentelemetry-web/blob/main/packages/honeycomb-opentelemetry-web/README.md ; https://github.com/honeycombio/honeycomb-opentelemetry-web/blob/main/packages/honeycomb-opentelemetry-web/src/base-otel-sdk.ts
- [S10] Next.js Pages Router, "How to use environment variables", section "Bundling Environment Variables for the Browser" and "Runtime Environment Variables". https://nextjs.org/docs/pages/guides/environment-variables
- [S11] Next.js Pages Router, "How to lazy load Client Components and libraries", sections `next/dynamic` and "With external libraries". https://nextjs.org/docs/pages/guides/lazy-loading
- [S12] OpenFeature Web SDK README, "Synchronous"/"Static context" (lines 126-138, 212-214). https://github.com/open-feature/js-sdk/blob/main/packages/web/README.md
- [S13] Next.js "Turbopack" (default bundler v16.0.0; ESM static and dynamic import supported; `--webpack` flag; `turbopackClientSideNestedAsyncChunking` build default true). https://nextjs.org/docs/app/api-reference/turbopack
- [S14] browser-sdk README (experimental note; traces `contextManager`, `propagators`, `processors`, `exportConfig.url`, `instrumentations`; sessions `createSessionSpanProcessor`, `createSessionLogRecordProcessor`; only `shutdown` documented). https://github.com/open-telemetry/opentelemetry-browser/blob/main/packages/sdk/README.md
- [S15] Honeycomb `src/types.ts` on main vs tag `honeycomb-opentelemetry-web-v1.3.0` (option-name diff) and `honeycomb-otel-sdk.ts` lines 25-47. https://github.com/honeycombio/honeycomb-opentelemetry-web/blob/main/packages/honeycomb-opentelemetry-web/src/types.ts
- [S16] Honeycomb `src/honeycomb-resource.ts` (`telemetry.distro.name`, `telemetry.distro.version`, `honeycomb.distro.*`) and `src/index.ts` exports on main and at v1.3.0. https://github.com/honeycombio/honeycomb-opentelemetry-web/blob/main/packages/honeycomb-opentelemetry-web/src/honeycomb-resource.ts
- [S17] `npm view @honeycombio/opentelemetry-web@1.3.0` (deps `~0.203.0`, `core ^2.0.0`, peers `auto-instrumentations-web ^0.49.0`, `context-zone ^2.0.0`).
- [S18] Semconv telemetry attribute registry (`telemetry.sdk.*`, `telemetry.distro.*` Stable; distro SHOULD note). https://github.com/open-telemetry/semantic-conventions/blob/main/docs/registry/attributes/telemetry.md ; opentelemetry-js `core/src/platform/browser/sdk-info.ts` (`SDK_INFO`, `webjs`) and `resources/src/ResourceImpl.ts` lines 160-162.

Repo files read (no edits):

- [R1] `src/frontend/package.json` (pins), `src/frontend/next.config.js` (`turbopack.root`, `webpack` fallback, `env` inlining).
- [R2] `src/frontend/package-lock.json` (six `node_modules/**/@opentelemetry/core` entries; `@honeycombio/opentelemetry-web` 1.3.0; `@openfeature/web-sdk` 1.5.0, `flagd-web-provider` 0.7.3).
- [R3] `src/frontend/utils/telemetry/FrontendTracer.ts` line 22 (`await import('@opentelemetry/context-zone')`).
- [R4] `src/frontend/utils/telemetry/HoneycombFrontendTracer.ts` (endpoint 37, `skipOptionsValidation` 39, fetch hook 53-55, `sessionProvider` 64-66, `visibilitychange` 86-90); `SessionIdProcessor.ts`.
- [R5] `src/frontend/pages/_document.tsx` (`process.env` line 8, baggage-based endpoint 22-27, `window.ENV` script before `NextScript` 29-35, 59-60).
- [R6] `skaffold-config/demo-values.yaml` lines 34-43 (`components.frontend.envOverrides`).
- [R7] `deploy/config-files/demo/values.yaml` lines 31-37 (prod `frontend.envOverrides`); `skaffold.yaml` lines 129-131 (chart `opentelemetry-demo` 0.39.0).
- [R8] `src/frontend/cypress/e2e/Home.cy.ts`, `Checkout.cy.ts`, `ProductDetail.cy.ts` (Cypress 15.6.0; no Playwright config in the frontend).
- [R9] `src/load-generator/locustfile.py` lines 655-706 (`LOCUST_BROWSER_TRAFFIC_ENABLED`, `PlaywrightUser`, `page.route` adding `synthetic_request=true` baggage).
- [R10] `src/frontend/pages/_app.tsx` lines 37-66 (tracer boot, then `OpenFeature.setContext` and `FlagdWebProvider`).
- [R11] `src/flagd/demo.flagd.json` (18 flags, all `defaultVariant` off; none read in `src/frontend`).
