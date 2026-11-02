// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

import { context, logs, propagation, trace } from '@opentelemetry/api';
import { CompositePropagator, W3CBaggagePropagator, W3CTraceContextPropagator } from '@opentelemetry/core';
import { BatchSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace';
import { BatchLogRecordProcessor, LoggerProvider } from '@opentelemetry/sdk-logs';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { getWebAutoInstrumentations } from '@opentelemetry/auto-instrumentations-web';
import { defaultResource, resourceFromAttributes, detectResources } from '@opentelemetry/resources';
import { browserDetector } from '@opentelemetry/opentelemetry-browser-detector';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { SessionIdLogRecordProcessor, SessionIdProcessor } from './SessionIdProcessor';

const {
  NEXT_PUBLIC_OTEL_SERVICE_NAME = '',
  NEXT_PUBLIC_OTEL_CLASSIC_WEB_INSTRUMENTATION = '',
  IS_SYNTHETIC_REQUEST = '',
} = typeof window !== 'undefined' ? window.ENV : {};

// Set WEB_OTEL_CLASSIC_INSTRUMENTATION=true on the frontend pod to go back to the classic
// opentelemetry-js / contrib web instrumentations (see enableClassicInstrumentations below).
const USE_CLASSIC_INSTRUMENTATION = NEXT_PUBLIC_OTEL_CLASSIC_WEB_INSTRUMENTATION === 'true';

// The exporters POST to /otlp-http/v1/{traces,logs}. The exporter marks those requests with
// suppressTracing, but neither the new nor the classic fetch/XHR instrumentation checks it, so
// every export would make a span (sent by the next export, which makes another span...) and a
// resource-timing event. Ignore our own telemetry traffic everywhere a network URL is recorded.
const TELEMETRY_URLS = [/\/otlp-http\//];

// The @opentelemetry/browser-instrumentation modules are not "classic" instrumentations:
//  - Do not pass them to registerInstrumentations(). Its README says to call enable() yourself.
//  - 0.9.0 still enables itself in the constructor, so create each one with enabled: false.
//  - 0.9.0 finds its default logger through the old @opentelemetry/api-logs global, but
//    sdk-logs 3.x registers with the logs API in @opentelemetry/api. Give it the providers directly.
type BrowserInstrumentation = {
  setTracerProvider(tracerProvider: TracerProvider): void;
  setLoggerProvider?(loggerProvider: LoggerProvider): void;
  enable(): void;
};

const FrontendTracer = async () => {
  // Browser-only modules: some read `window` when they load, and Next.js also loads this file on
  // the server. Import them here, inside the function that only runs in the browser.
  const { ZoneContextManager } = await import('@opentelemetry/context-zone');
  const { LongTaskInstrumentation } = await import('@opentelemetry/instrumentation-long-task');
  const { ConsoleInstrumentation } = await import('@opentelemetry/browser-instrumentation/experimental/console');
  const { ErrorsInstrumentation } = await import('@opentelemetry/browser-instrumentation/experimental/errors');
  const { FetchInstrumentation } = await import('@opentelemetry/browser-instrumentation/experimental/fetch');
  const { NavigationInstrumentation } = await import('@opentelemetry/browser-instrumentation/experimental/navigation');
  const { NavigationTimingInstrumentation } = await import(
    '@opentelemetry/browser-instrumentation/experimental/navigation-timing'
  );
  const { ResourceTimingInstrumentation } = await import(
    '@opentelemetry/browser-instrumentation/experimental/resource-timing'
  );
  const { UserActionInstrumentation } = await import('@opentelemetry/browser-instrumentation/experimental/user-action');
  const { WebVitalsInstrumentation } = await import('@opentelemetry/browser-instrumentation/experimental/web-vitals');
  const { XhrInstrumentation } = await import('@opentelemetry/browser-instrumentation/experimental/xhr');

  let resource = defaultResource()
    .merge(
      resourceFromAttributes({
        [ATTR_SERVICE_NAME]: NEXT_PUBLIC_OTEL_SERVICE_NAME,
      }),
    )
    .merge(detectResources({ detectors: [browserDetector] }));

  const tracerProvider = new TracerProvider({
    resource,
    spanProcessors: [
      new SessionIdProcessor(),
      new BatchSpanProcessor({
        exporter: new OTLPTraceExporter({
          // Send to the origin the page came from (frontend-proxy routes /otlp-http to the collector).
          // The chart's PUBLIC_OTEL_EXPORTER_OTLP_TRACES_ENDPOINT hard-codes localhost:8080, which
          // breaks when the port-forward is on another port.
          url: `${window.location.origin}/otlp-http/v1/traces`,
        }),
        scheduledDelayMillis: 500,
      }),
    ],
  });

  // Most browser-instrumentation modules send events (log records), not spans.
  const loggerProvider = new LoggerProvider({
    resource,
    processors: [
      new SessionIdLogRecordProcessor(),
      new BatchLogRecordProcessor({
        exporter: new OTLPLogExporter({
          url: `${window.location.origin}/otlp-http/v1/logs`,
        }),
        scheduledDelayMillis: 500,
      }),
    ],
  });

  context.setGlobalContextManager(new ZoneContextManager().enable());
  propagation.setGlobalPropagator(
    new CompositePropagator({
      propagators: [
        new W3CBaggagePropagator(),
        new W3CTraceContextPropagator(),
      ],
    }),
  );
  trace.setGlobalTracerProvider(tracerProvider);
  logs.setGlobalLoggerProvider(loggerProvider);

  const enable = (instrumentation: BrowserInstrumentation) => {
    instrumentation.setTracerProvider(tracerProvider);
    instrumentation.setLoggerProvider?.(loggerProvider);
    instrumentation.enable();
  };

  // On in both modes: nothing classic does these jobs (in this app).
  enable(new NavigationInstrumentation({ enabled: false })); // browser.navigation: hard loads and SPA route changes
  enable(new ErrorsInstrumentation({ enabled: false })); // exception: uncaught errors and unhandled rejections
  // Core Web Vitals (LCP, INP, CLS, FCP, TTFB) via Google's web-vitals.
  // includeRawAttribution (experimental): the log body is the JSON-stringified web-vitals
  // attribution object (LCP element, INP input/processing/presentation delay, CLS shift target...).
  // It is one string, not attributes; see opentelemetry-browser#471 for attribution as attributes.
  enable(new WebVitalsInstrumentation({ enabled: false, includeRawAttribution: true }));
  enable(new ConsoleInstrumentation({ enabled: false })); // browser.console: console.log/warn/error/info/debug

  if (USE_CLASSIC_INSTRUMENTATION) {
    enableClassicInstrumentations(tracerProvider);
  } else {
    // The new replacements for the classic set. Fetch and XHR still make spans; the others send events.
    enable(
      new FetchInstrumentation({
        enabled: false,
        ignoreUrls: TELEMETRY_URLS,
        propagateTraceHeaderCorsUrls: [/.*/],
        applyCustomAttributesOnSpan(span) {
          span.setAttribute('demo.synthetic_request', IS_SYNTHETIC_REQUEST);
        },
      }),
    );
    enable(new XhrInstrumentation({ enabled: false, ignoreUrls: TELEMETRY_URLS, propagateTraceHeaderCorsUrls: [/.*/] }));
    enable(new UserActionInstrumentation({ enabled: false })); // clicks, as events (classic made a span per click)
    enable(new NavigationTimingInstrumentation({ enabled: false })); // page load timing (was the documentLoad span)
    // One event per loaded resource, linked to its fetch span.
    enable(new ResourceTimingInstrumentation({ enabled: false, ignoreUrls: TELEMETRY_URLS }));
  }

  // Classic contrib instrumentation, kept in both modes: Long Tasks has no replacement in
  // opentelemetry-browser ("No replacement planned"). One span per main-thread block over 50 ms.
  registerInstrumentations({
    tracerProvider,
    instrumentations: [new LongTaskInstrumentation()],
  });

  // Not installed on purpose. These contrib packages are the older versions of
  // NavigationInstrumentation and ErrorsInstrumentation above; with both on, every navigation
  // and every uncaught error is recorded twice. Install one only to compare its output with the
  // new module, or as a fallback if the new module breaks (and then turn the new one off).
  //   npm install --save-exact @opentelemetry/instrumentation-browser-navigation@0.17.0
  //   npm install --save-exact @opentelemetry/instrumentation-web-exception@0.17.0
  // registerInstrumentations({
  //   tracerProvider,
  //   loggerProvider,
  //   instrumentations: [
  //     new BrowserNavigationInstrumentation(), // from @opentelemetry/instrumentation-browser-navigation
  //     new WebExceptionInstrumentation(), // from @opentelemetry/instrumentation-web-exception
  //   ],
  // });
};

// The classic web instrumentations, deprecated or soon to be deprecated upstream. Each one has a
// replacement above, so this mode turns those replacements off:
//   instrumentation-fetch            -> browser-instrumentation fetch
//   instrumentation-xml-http-request -> browser-instrumentation xhr
//   instrumentation-user-interaction -> browser-instrumentation user-action (event, not span)
//   instrumentation-document-load    -> browser-instrumentation navigation-timing + resource-timing (events)
// Use it to get the older trace shape back: a span per click that parents its fetch spans, and a
// documentLoad span tree.
function enableClassicInstrumentations(tracerProvider: TracerProvider) {
  registerInstrumentations({
    tracerProvider,
    instrumentations: [
      getWebAutoInstrumentations({
        '@opentelemetry/instrumentation-fetch': {
          ignoreUrls: TELEMETRY_URLS,
          propagateTraceHeaderCorsUrls: /.*/,
          clearTimingResources: true,
          applyCustomAttributesOnSpan(span) {
            span.setAttribute('demo.synthetic_request', IS_SYNTHETIC_REQUEST);
          },
        },
        '@opentelemetry/instrumentation-xml-http-request': {
          ignoreUrls: TELEMETRY_URLS,
        },
      }),
    ],
  });
}

export default FrontendTracer;
