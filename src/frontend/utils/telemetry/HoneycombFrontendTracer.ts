// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

// This is a Next.js application. This instrumentation configuration is for the
// react-side client
'use client';

declare global {
    interface Window {
        __flushTelemetry?: () => Promise<void>;
    }
}

import { CompositePropagator, W3CBaggagePropagator, W3CTraceContextPropagator } from '@opentelemetry/core';
import { getWebAutoInstrumentations } from '@opentelemetry/auto-instrumentations-web';
import { ZoneContextManager} from '@opentelemetry/context-zone';
import { HoneycombWebSDK, WebVitalsInstrumentation } from '@honeycombio/opentelemetry-web';

const {
    NEXT_PUBLIC_OTEL_SERVICE_NAME = '',
    // NEXT_PUBLIC_OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = '',
    IS_SYNTHETIC_REQUEST = '',
} = typeof window !== 'undefined' ? window.ENV : {};

const configDefaults = {
    ignoreNetworkEvents: true,
    propagateTraceHeaderCorsUrls: [
        /.+/g, // Regex to match your backend URLs. Update to the domains you wish to include.
    ]
};

const HoneycombFrontendTracer = (sessionId: string) => {
    const sdk = new HoneycombWebSDK({
        serviceName: NEXT_PUBLIC_OTEL_SERVICE_NAME,
        contextManager: new ZoneContextManager(),
        // TODO - vet this. It works, but is it really the right move instead of reading the old env var?
        endpoint: `${window.location.origin}/otlp-http/v1/traces`,
        // we don't have an API key, don't complain
        skipOptionsValidation: true,
        textMapPropagator: new CompositePropagator({
            propagators: [
                new W3CBaggagePropagator(),
                new W3CTraceContextPropagator()],
        }),

        instrumentations: [
            getWebAutoInstrumentations({
              // alternative: turn on networkEvents so we can see data for resourceFetch content sizes
              //'@opentelemetry/instrumentation-document-load': { ...configDefaults, ignoreNetworkEvents: false },
              '@opentelemetry/instrumentation-document-load': configDefaults,
                '@opentelemetry/instrumentation-fetch': {
                  ...configDefaults,
                    // clearTimingResources: true,
                    applyCustomAttributesOnSpan(span) {
                        span.setAttribute('app.synthetic_request', IS_SYNTHETIC_REQUEST);
                    },
                    // Report exceptions on 500 errors - using newer OTEL Semantics
                    semconvStabilityOptIn: 'http/dup',
                },
                '@opentelemetry/instrumentation-xml-http-request': configDefaults,
                '@opentelemetry/instrumentation-user-interaction': {
                    enabled: true,
                    eventNames: ['click', 'submit']
                }
            }),
            new WebVitalsInstrumentation({
                enabled: true,
                vitalsToTrack: ['FCP', 'INP', 'CLS', 'LCP', 'TTFB']
            })
        ],
        sessionProvider: {
            getSessionId: () => sessionId
        }
    });

    sdk.start();

    // TODO - add a build flag to enable this for load testing platforms only
    // Expose for programmatic access (from Playwright for example) to flush telemetry spans
    if (typeof window !== 'undefined') {
        window.__flushTelemetry = () => { return sdk.forceFlush(); }
    }
}

export default HoneycombFrontendTracer;
