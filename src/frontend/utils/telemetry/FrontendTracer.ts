// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

'use client';

import {HoneycombWebSDK} from "@honeycombio/opentelemetry-web";
import {getWebAutoInstrumentations} from "@opentelemetry/auto-instrumentations-web";
import {ZoneContextManager} from "@opentelemetry/context-zone";
import { SessionIdProcessor } from './SessionIdProcessor';

// Determine where this is being mounted
const componentType = typeof window === 'undefined' ? 'server' : 'client';

const configDefaults = {
  ignoreNetworkEvents: true,
  propagateTraceHeaderCorsUrls: [ /^(.+)$/ ]
}

// singleton - only instrument 1x - see below
let loaded = false;

export default function FrontendTracer() {

 // we need to only run this on the client, actions like SSR will fail with an error
  if (componentType === 'server') {
    return null;
  }

  // for singleton pattern - for some reason the browser is reloading the frontend component,
  // so this prevents it from doing so
  if (!loaded) {
    // until we can expose client-side session.id from HoneycombWebSDK, we'll use the pre-built SessionGateway API
    loaded = true;
    try {
      // doesn't specify SDK endpoint, defaults to us v1/traces endpoint
      const sdk = new HoneycombWebSDK({
        contextManager: new ZoneContextManager(),
        // TODO - grab from env - should be NEXT_PUBLIC_OTEL_EXPORTER_OTLP_TRACES_ENDPOINT but
        // fixing that in the /kubernetes/opentelemetry-demo.yaml file and redeploying doesn't
        // seem to expose it to the runtime. I think this is a "bake it into the next.js build" issue
        // via https://nextjs.org/docs/pages/building-your-application/configuring/environment-variables#bundling-environment-variables-for-the-browser
        // - and if so, that'll require more thinky pain.

        // for now, since it's relative to the browser root in the reverse proxy's exposed URIs
        // use that
        endpoint: `${window.location.protocol}//${window.location.host}/otlp-http/v1/traces`,
        serviceName: 'frontend-web',
        skipOptionsValidation: true,
        instrumentations: [
          getWebAutoInstrumentations({
            // Loads custom configuration for xml-http-request instrumentation.
            '@opentelemetry/instrumentation-xml-http-request': configDefaults,
            '@opentelemetry/instrumentation-fetch': configDefaults,
            '@opentelemetry/instrumentation-document-load': configDefaults,
            '@opentelemetry/instrumentation-user-interaction': {enabled: true}
          })
        ],

        spanProcessors: [new SessionIdProcessor()],
      });
      sdk.start();
      console.log("Frontend tracer is configured and running.");
    } catch (e) {
      console.log(`error... ${new Date().toISOString()}`);
      console.error(e);
    }
  }
  // render nothing, just use this to instrument
  return null;
}
