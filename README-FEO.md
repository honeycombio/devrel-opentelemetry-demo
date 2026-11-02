# Frontend Observability (FEO): browser telemetry in the frontend

This document lists the OpenTelemetry instrumentation that runs in the browser for the
`frontend` service (the Next.js store). It tells you what is on, what each one records, and
where its source is.

All setup is in [`src/frontend/utils/telemetry/FrontendTracer.ts`](src/frontend/utils/telemetry/FrontendTracer.ts).
`src/frontend/pages/_app.tsx` calls it once, in the browser only.

## Summary

| Instrumentation | Package | Signal | Default mode | Classic mode |
|---|---|---|---|---|
| [Navigation](#navigation) | `@opentelemetry/browser-instrumentation` 0.9.0 | Event | On | On |
| [Errors](#errors) | `@opentelemetry/browser-instrumentation` 0.9.0 | Event | On | On |
| [Web Vitals](#web-vitals) | `@opentelemetry/browser-instrumentation` 0.9.0 | Event | On | On |
| [Console](#console) | `@opentelemetry/browser-instrumentation` 0.9.0 | Event | On | On |
| [Fetch](#fetch) | `@opentelemetry/browser-instrumentation` 0.9.0 | Span | On | Off |
| [XHR](#xhr) | `@opentelemetry/browser-instrumentation` 0.9.0 | Span | On | Off |
| [User Action](#user-action) | `@opentelemetry/browser-instrumentation` 0.9.0 | Event | On | Off |
| [Navigation Timing](#navigation-timing) | `@opentelemetry/browser-instrumentation` 0.9.0 | Event | On | Off |
| [Resource Timing](#resource-timing) | `@opentelemetry/browser-instrumentation` 0.9.0 | Event | On | Off |
| [Long Task](#long-task) | `@opentelemetry/instrumentation-long-task` 0.68.0 | Span | On | On |
| [Classic web set](#classic-mode-flag) | `@opentelemetry/auto-instrumentations-web` 0.69.0 | Span | Off | On |
| [Browser Navigation (contrib)](#not-installed) | `@opentelemetry/instrumentation-browser-navigation` | Event | Not installed | Not installed |
| [Web Exception (contrib)](#not-installed) | `@opentelemetry/instrumentation-web-exception` | Event | Not installed | Not installed |

"Event" means an OpenTelemetry log record with an event name. In Honeycomb, events go to the
same `frontend-web` dataset as the spans (the service name comes from `WEB_OTEL_SERVICE_NAME`).

## How the pipeline works

- **Traces:** `TracerProvider` → `SessionIdProcessor` → `BatchSpanProcessor` → OTLP/HTTP to
  `${window.location.origin}/otlp-http/v1/traces`.
- **Events (logs):** `LoggerProvider` → `SessionIdLogRecordProcessor` →
  `BatchLogRecordProcessor` → OTLP/HTTP to `${window.location.origin}/otlp-http/v1/logs`.
- `frontend-proxy` (Envoy) sends `/otlp-http/*` to the collector. The collector's logs
  pipeline sends the events to Honeycomb.
- **Session attributes:** spans and events both get `session.id`, `enduser.id`, and (after a
  corporate login) `demo.corporate_user.id` and `demo.company`. See
  [`SessionIdProcessor.ts`](src/frontend/utils/telemetry/SessionIdProcessor.ts).
- **Context:** `ZoneContextManager` keeps the active span across async calls. W3C Trace
  Context and W3C Baggage headers go on outgoing requests, so browser spans and server spans
  are in the same trace.
- **Telemetry traffic is ignored:** `fetch`, `xhr` and `resource-timing` (and the classic
  `fetch` and `xhr`) have `ignoreUrls: [/\/otlp-http\//]`. The exporters mark their requests
  with `suppressTracing`, but these instrumentations do not check that mark. Without the
  ignore rule, each export makes a span, which the next export sends, which makes another span.

### Why the new modules are not passed to `registerInstrumentations()`

The `@opentelemetry/browser-instrumentation` modules use a different pattern from the
classic ones:

1. The [opentelemetry-browser README](https://github.com/open-telemetry/opentelemetry-browser#migrate-from-classic-browser-instrumentations)
   says not to use `registerInstrumentations()` with them, and to call `enable()` yourself.
2. Version 0.9.0 still turns itself on in its constructor. So each module is created with
   `enabled: false`, then gets its providers, then `enable()` is called.
3. Version 0.9.0 looks for its default logger in the old `@opentelemetry/api-logs` global.
   `sdk-logs` 3.x registers with the logs API in `@opentelemetry/api` 1.10. So the
   `LoggerProvider` and `TracerProvider` are given to each module directly.

These modules are also loaded with `await import()` inside `FrontendTracer()`. Some of them
read `window` when they load, and Next.js also loads `FrontendTracer.ts` on the server.

---

## `@opentelemetry/browser-instrumentation` (opentelemetry-browser)

The new browser instrumentations from the OpenTelemetry Browser SIG. The repo README says
they replace the classic browser instrumentations in `opentelemetry-js` and
`opentelemetry-js-contrib`, which are deprecated or will be deprecated soon.

- Repo: <https://github.com/open-telemetry/opentelemetry-browser>
- Package source at the version we use (0.9.0):
  <https://github.com/open-telemetry/opentelemetry-browser/tree/browser-instrumentation-v0.9.0/packages/instrumentation>
- Package README: <https://github.com/open-telemetry/opentelemetry-browser/blob/browser-instrumentation-v0.9.0/packages/instrumentation/README.md>
- Migration guide: <https://github.com/open-telemetry/opentelemetry-browser/blob/main/docs/migration-guide.md>
- npm: <https://www.npmjs.com/package/@opentelemetry/browser-instrumentation>

‼️ This package is **experimental**. Its modules are under `./experimental/*`, and a minor
release can break the API. We pin the exact version (`0.9.0`).

### Navigation

- Import: `@opentelemetry/browser-instrumentation/experimental/navigation`
- Source: <https://github.com/open-telemetry/opentelemetry-browser/tree/browser-instrumentation-v0.9.0/packages/instrumentation/src/navigation>
- Signal: event `browser.navigation`
- What it is for: one event for the first page load (hard navigation) and one for each SPA
  route change (`pushState`, `replaceState`, `popstate`, hash change). Use it to see the path
  a user takes through the store.
- Main attributes: `url.full`, `browser.navigation.same_document`,
  `browser.navigation.hash_change`, `browser.navigation.type` (`push`, `replace`, `reload`,
  `traverse`).
- Replaces: contrib `instrumentation-browser-navigation`.

### Errors

- Import: `@opentelemetry/browser-instrumentation/experimental/errors`
- Source: <https://github.com/open-telemetry/opentelemetry-browser/tree/browser-instrumentation-v0.9.0/packages/instrumentation/src/errors>
- Signal: event `exception`, severity `ERROR`
- What it is for: one event for each uncaught error (`window` `error`) and each unhandled
  promise rejection (`unhandledrejection`). Use it to find JavaScript errors that users hit.
- Main attributes: `exception.type`, `exception.message`, `exception.stacktrace`.
- Replaces: contrib `instrumentation-web-exception`.

### Web Vitals

- Import: `@opentelemetry/browser-instrumentation/experimental/web-vitals`
- Source: <https://github.com/open-telemetry/opentelemetry-browser/tree/browser-instrumentation-v0.9.0/packages/instrumentation/src/web-vitals>
- Uses: Google's [`web-vitals`](https://github.com/GoogleChrome/web-vitals) library (not the
  Honeycomb web SDK).
- Signal: one event for each Core Web Vital report.
- What it is for: the page-experience measures that Google uses: LCP (Largest Contentful
  Paint), INP (Interaction to Next Paint), CLS (Cumulative Layout Shift), FCP (First
  Contentful Paint) and TTFB (Time to First Byte). Use it to find slow or unstable pages.
- Config: `includeRawAttribution: true` (experimental). The event `body` is the
  JSON-stringified `web-vitals` attribution object: for example the LCP element and resource,
  INP input delay, processing duration and presentation delay, and the CLS shift target.
  It is one string with camelCase keys, not attributes, so you must parse `body` to filter or
  group on it. [#471](https://github.com/open-telemetry/opentelemetry-browser/issues/471)
  proposes attribution as `browser.web_vital.attribution.*` attributes.
- Option not used now: `reportAllChanges`.
- No page URL: 0.9.0 sends only the six semconv attributes. PR
  [#512](https://github.com/open-telemetry/opentelemetry-browser/pull/512) adds
  `browser.web_vital.navigation_url`. See the "Upstream CWV Issues" Notion page.

### Console

- Import: `@opentelemetry/browser-instrumentation/experimental/console`
- Source: <https://github.com/open-telemetry/opentelemetry-browser/tree/browser-instrumentation-v0.9.0/packages/instrumentation/src/console>
- Signal: event `browser.console`
- What it is for: one event for each `console.log`, `warn`, `error`, `info` and `debug` call.
  Use it to see in Honeycomb what the browser console showed the user.
- Main attribute: `browser.console.method`.
- Note: this can be noisy. To capture fewer methods, set `logMethods: ['error', 'warn']`.

### Fetch

- Import: `@opentelemetry/browser-instrumentation/experimental/fetch`
- Source: <https://github.com/open-telemetry/opentelemetry-browser/tree/browser-instrumentation-v0.9.0/packages/instrumentation/src/fetch>
- Signal: one span for each `window.fetch` request.
- What it is for: timing and status of the browser's API calls (`/api/cart`, `/api/checkout`,
  ...). It adds W3C trace headers, so the `frontend` server span is a child of this span.
- Main attributes: `http.request.method`, `url.full`, `server.address`, `server.port`,
  `http.response.status_code`, `error.type`. We also add `demo.synthetic_request`.
- Config: `propagateTraceHeaderCorsUrls: [/.*/]`, `ignoreUrls: [/\/otlp-http\//]`.
- Replaces: `@opentelemetry/instrumentation-fetch` (opentelemetry-js, deprecated).

### XHR

- Import: `@opentelemetry/browser-instrumentation/experimental/xhr`
- Source: <https://github.com/open-telemetry/opentelemetry-browser/tree/browser-instrumentation-v0.9.0/packages/instrumentation/src/xhr>
- Signal: one span for each `XMLHttpRequest`.
- What it is for: the same as Fetch, for code that uses XHR. It adds W3C trace headers.
- Config: `propagateTraceHeaderCorsUrls: [/.*/]`, `ignoreUrls: [/\/otlp-http\//]`.
- Replaces: `@opentelemetry/instrumentation-xml-http-request` (opentelemetry-js, deprecated).

### User Action

- Import: `@opentelemetry/browser-instrumentation/experimental/user-action`
- Source: <https://github.com/open-telemetry/opentelemetry-browser/tree/browser-instrumentation-v0.9.0/packages/instrumentation/src/user-action>
- Signal: one event for each click (default `autoCapturedActions: ['click']`).
- What it is for: what the user clicked, including a CSS selector for the target element.
  Attributes named `data-otel-*` on the element are added to the event. For example,
  `data-otel-feature="signup"` adds `feature: signup`.
- Replaces: contrib `instrumentation-user-interaction`.
- ‼️ Trace shape change: the classic version made a **span** per click, and that span was
  the parent of the fetch spans the click started. This version makes an **event**, so browser
  fetch spans are now root spans.

### Navigation Timing

- Import: `@opentelemetry/browser-instrumentation/experimental/navigation-timing`
- Source: <https://github.com/open-telemetry/opentelemetry-browser/tree/browser-instrumentation-v0.9.0/packages/instrumentation/src/navigation-timing>
- Signal: event with the page's
  [`PerformanceNavigationTiming`](https://developer.mozilla.org/en-US/docs/Web/API/PerformanceNavigationTiming)
  data.
- What it is for: how long each part of the page load took (DNS, TCP, TLS, request,
  response, DOM processing, load event).
- Replaces (with Resource Timing): contrib `instrumentation-document-load` (`documentLoad`
  span tree).

### Resource Timing

- Import: `@opentelemetry/browser-instrumentation/experimental/resource-timing`
- Source: <https://github.com/open-telemetry/opentelemetry-browser/tree/browser-instrumentation-v0.9.0/packages/instrumentation/src/resource-timing>
- Signal: one event for each resource the browser loads (script, CSS, image, font, fetch,
  XHR), from
  [`PerformanceResourceTiming`](https://developer.mozilla.org/en-US/docs/Web/API/PerformanceResourceTiming).
- What it is for: find slow or large files. Each event has URL, initiator type, duration,
  timing phases, transfer and body sizes, and protocol. Events for fetch and XHR requests
  are linked to their span.
- It uses `requestIdleCallback` to process entries in batches, so it does not block the main
  thread. It flushes when the page becomes hidden.
- Config: `ignoreUrls: [/\/otlp-http\//]`.
- Note: this is the module with the most volume (one event per file on every page).
- **Talking point: what you can cut.** In 30 minutes of local traffic this module sent
  17,830 events. In the same time, fetch sent 3,623 spans, so resource timing was about 5×
  the fetch volume. It is the biggest cut you can make for the smallest loss. Turning it off
  removes only the per-file detail (DNS, connect, TLS, wait and download times, sizes, cache
  hits, protocol, render-blocking). Navigation Timing still gives the same phases for the
  page itself, and fetch spans keep the trace join to the backend. Turn it back on when a
  frontend problem starts to show (slow assets, CDN or cache misses, large bundles).
  - Today no flag controls this module by itself. To turn it off and on again you must change
    the code and deploy again. A per-module env var or flagd flag would make the
    "flag it back on" story true.

### In the repo but not in 0.9.0

- **Element Timing** (`packages/instrumentation/src/element-timing` on `main`) is not in the
  0.9.0 release.
- A `browser-instrumentation-v0.10.0` tag exists on GitHub, but npm `latest` is still 0.9.0.
  Before you upgrade, read the release notes, because the modules are experimental.

---

## `@opentelemetry/instrumentation-long-task` (opentelemetry-js-contrib)

- Source (0.68.0): <https://github.com/open-telemetry/opentelemetry-js-contrib/tree/instrumentation-long-task-v0.68.0/packages/instrumentation-long-task>
- npm: <https://www.npmjs.com/package/@opentelemetry/instrumentation-long-task>
- Signal: one span `longtask` for each
  [Long Task](https://developer.mozilla.org/en-US/docs/Web/API/PerformanceLongTaskTiming)
  (main-thread work of more than 50 ms).
- What it is for: find JavaScript that freezes the page, so clicks and typing feel slow.
- Why it is a classic instrumentation: the opentelemetry-browser repo says "No replacement
  planned". It is registered with `registerInstrumentations({ tracerProvider })`.
- On in both modes.

---

## Classic mode (flag)

Set the env var `WEB_OTEL_CLASSIC_INSTRUMENTATION=true` on the `frontend` pod to go back to
the classic web instrumentations. `pages/_document.tsx` passes it to the browser as
`window.ENV.NEXT_PUBLIC_OTEL_CLASSIC_WEB_INSTRUMENTATION`. For a local deploy, uncomment the
example in `skaffold-config/demo-values.yaml` (frontend `envOverrides`).

In classic mode, `getWebAutoInstrumentations()` turns on the four instrumentations below,
and their five new replacements are turned off, so nothing is recorded twice. Navigation,
Errors, Web Vitals, Console and Long Task stay on.

Use classic mode to get the older trace shape back: a span per click that is the parent of
its fetch spans, and a `documentLoad` span tree.

- `@opentelemetry/auto-instrumentations-web` 0.69.0 (the bundle):
  <https://github.com/open-telemetry/opentelemetry-js-contrib/tree/auto-instrumentations-web-v0.69.0/packages/auto-instrumentations-web>

| Classic instrumentation | Source | Records | New replacement |
|---|---|---|---|
| `@opentelemetry/instrumentation-fetch` | <https://github.com/open-telemetry/opentelemetry-js/tree/experimental/v0.300.0/experimental/packages/opentelemetry-instrumentation-fetch> | Span per `fetch` | Fetch |
| `@opentelemetry/instrumentation-xml-http-request` | <https://github.com/open-telemetry/opentelemetry-js/tree/experimental/v0.300.0/experimental/packages/opentelemetry-instrumentation-xml-http-request> | Span per XHR | XHR |
| `@opentelemetry/instrumentation-user-interaction` | <https://github.com/open-telemetry/opentelemetry-js-contrib/tree/instrumentation-user-interaction-v0.68.0/packages/instrumentation-user-interaction> | Span per click (parent of its fetch spans) | User Action |
| `@opentelemetry/instrumentation-document-load` | <https://github.com/open-telemetry/opentelemetry-js-contrib/tree/instrumentation-document-load-v0.69.0/packages/instrumentation-document-load> | `documentLoad` span with `documentFetch` and `resourceFetch` children | Navigation Timing + Resource Timing |

Classic `fetch` and `xhr` also have `ignoreUrls: [/\/otlp-http\//]`.

---

## Not installed

These two contrib packages are the older versions of Navigation and Errors. If both are on,
each navigation and each uncaught error is recorded twice. `FrontendTracer.ts` has them as
commented-out lines. Install one only to compare its output with the new module, or as a
fallback if the new module breaks (and then turn the new one off).

| Package | Source | Replaced by |
|---|---|---|
| `@opentelemetry/instrumentation-browser-navigation` 0.17.0 | <https://github.com/open-telemetry/opentelemetry-js-contrib/tree/instrumentation-browser-navigation-v0.17.0/packages/instrumentation-browser-navigation> | Navigation |
| `@opentelemetry/instrumentation-web-exception` 0.17.0 | <https://github.com/open-telemetry/opentelemetry-js-contrib/tree/instrumentation-web-exception-v0.17.0/packages/instrumentation-web-exception> | Errors |

`@opentelemetry/plugin-react-load` is deprecated on npm. Do not use it.

---

## SDK packages used by the browser

| Package | Version | Source |
|---|---|---|
| `@opentelemetry/api` | 1.10.0 | <https://github.com/open-telemetry/opentelemetry-js/tree/v3.0.0/api> |
| `@opentelemetry/sdk-trace` | 3.0.0 | <https://github.com/open-telemetry/opentelemetry-js/tree/v3.0.0/packages/sdk-trace> |
| `@opentelemetry/sdk-logs` | 3.0.0 | <https://github.com/open-telemetry/opentelemetry-js/tree/v3.0.0/packages/sdk-logs> |
| `@opentelemetry/exporter-trace-otlp-http` | 0.300.0 | <https://github.com/open-telemetry/opentelemetry-js/tree/experimental/v0.300.0/experimental/packages/exporter-trace-otlp-http> |
| `@opentelemetry/exporter-logs-otlp-http` | 0.300.0 | <https://github.com/open-telemetry/opentelemetry-js/tree/experimental/v0.300.0/experimental/packages/exporter-logs-otlp-http> |
| `@opentelemetry/context-zone` | 3.0.0 | <https://github.com/open-telemetry/opentelemetry-js/tree/v3.0.0/packages/opentelemetry-context-zone> |
| `@opentelemetry/opentelemetry-browser-detector` | 0.300.0 | <https://github.com/open-telemetry/opentelemetry-js/tree/experimental/v0.300.0/experimental/packages/opentelemetry-browser-detector> |

## Things to know

- **Dependency install:** `@honeycombio/opentelemetry-web` (used only by the unused
  `HoneycombFrontendTracer.ts`) has an old peer range for `@opentelemetry/context-zone`. A
  plain `npm install` fails with ERESOLVE on some npm versions, and an install with
  `--legacy-peer-deps` removes the `@openfeature/*` peers from the lock. To change the
  frontend dependencies, run `npm install --force` in the same Node image as the
  `src/frontend/Dockerfile` (npm 11.20.0), then check that a plain `npm ci` passes there.
- **Volume:** in production, the collector daemonset's logs pipeline sends logs to several
  exporters (`otlp/refinery`, `otlp/logging-dogfood`, `otlp/logging-island-of-misfit-toys`,
  `otlp/bindplane`). Browser events, mostly Resource Timing, go to all of them.
