// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

// Browser telemetry for the Next.js client, on the upstream OpenTelemetry browser SDK.
// The Node side lives in Instrumentation.js and is unrelated.
'use client';

import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { startBrowserSdk } from '@opentelemetry/browser-sdk';
import { createDocumentSpanProcessor, createDocumentLogRecordProcessor, createLocationDocumentProvider } from '@opentelemetry/browser-sdk/document';
import { getWebAutoInstrumentations } from '@opentelemetry/auto-instrumentations-web';
import { ErrorsInstrumentation } from '@opentelemetry/browser-instrumentation/experimental/errors';
import { WebVitalsInstrumentation } from '@opentelemetry/browser-instrumentation/experimental/web-vitals';
import { detectResources } from '@opentelemetry/resources';
import { browserDetector } from '@opentelemetry/opentelemetry-browser-detector';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { SessionIdProcessor, SessionIdLogRecordProcessor } from './SessionIdProcessor';
import { BrowserAttributesSpanProcessor, browserResourceAttributes } from './BrowserAttributes';

const {
  NEXT_PUBLIC_OTEL_SERVICE_NAME = '',
  IS_SYNTHETIC_REQUEST = '',
} = typeof window !== 'undefined' ? window.ENV : {};

const configDefaults = {
  ignoreNetworkEvents: true,
  propagateTraceHeaderCorsUrls: [/.+/g],
};

const FrontendTracer = async () => {
  if (typeof window === 'undefined') return;

  const { ZoneContextManager } = await import('@opentelemetry/context-zone');

  // Same origin: envoy strips /otlp-http/ and forwards to the collector.
  const origin = window.location.origin;
  // The browser batch processors flush on visibilitychange/pagehide by default.
  const spanBatch = new BatchSpanProcessor({
    exporter: new OTLPTraceExporter({ url: `${origin}/otlp-http/v1/traces` }),
    scheduledDelayMillis: 500,
  });
  const logBatch = new BatchLogRecordProcessor({
    exporter: new OTLPLogExporter({ url: `${origin}/otlp-http/v1/logs` }),
    scheduledDelayMillis: 500,
  });

  const documentProvider = createLocationDocumentProvider();

  // browser-sdk runs no resource detectors, so run them here.
  startBrowserSdk({
    serviceName: NEXT_PUBLIC_OTEL_SERVICE_NAME,
    resourceAttributes: {
      ...detectResources({ detectors: [browserDetector] }).attributes,
      ...browserResourceAttributes(),
    },
    traces: {
      contextManager: new ZoneContextManager(),
      processors: [
        new SessionIdProcessor(),
        new BrowserAttributesSpanProcessor(),
        createDocumentSpanProcessor(documentProvider),
        spanBatch,
      ],
    },
    logs: {
      processors: [new SessionIdLogRecordProcessor(), createDocumentLogRecordProcessor(documentProvider), logBatch],
    },
  });

  registerInstrumentations({
    instrumentations: [
      getWebAutoInstrumentations({
        '@opentelemetry/instrumentation-document-load': configDefaults,
        '@opentelemetry/instrumentation-fetch': {
          ...configDefaults,
          applyCustomAttributesOnSpan(span) {
            span.setAttribute('app.synthetic_request', IS_SYNTHETIC_REQUEST);
          },
        },
        '@opentelemetry/instrumentation-xml-http-request': configDefaults,
        '@opentelemetry/instrumentation-user-interaction': {
          enabled: true,
          eventNames: ['click', 'submit'],
        },
      }),
      // web vitals and exceptions are emitted as log records, not spans
      new WebVitalsInstrumentation({ includeRawAttribution: true }),
      new ErrorsInstrumentation({
        applyCustomAttributes: () => ({ 'app.synthetic_request': IS_SYNTHETIC_REQUEST }),
      }),
    ],
  });
};

export default FrontendTracer;
