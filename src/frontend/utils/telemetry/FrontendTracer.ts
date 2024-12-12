// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

'use client';

import {HoneycombWebSDK} from "@honeycombio/opentelemetry-web";
import {getWebAutoInstrumentations} from "@opentelemetry/auto-instrumentations-web";
import {ZoneContextManager} from "@opentelemetry/context-zone";

// Determine where this is being mounted
const componentType = typeof window === 'undefined' ? 'server' : 'client';

const configDefaults = {
  ignoreNetworkEvents: true
}

export default function FrontendTracer() {
  // we need to only run this on the client, actions like SSR will fail with an error
  if (componentType === 'server') {
    return null;
  }

  // only instrument 1x. If we've already mounted the component and set up the ref, 
  // we do nothing here.
    try {
      // doesn't specify SDK endpoint, defaults to us v1/traces endpoint
      const apiRef = new HoneycombWebSDK({
        contextManager: new ZoneContextManager(),
        endpoint: '/otlp-http/v1/traces',
        serviceName: 'frontend-web',
        skipOptionsValidation: true,
        instrumentations: [
          getWebAutoInstrumentations({
            // Loads custom configuration for xml-http-request instrumentation.
            '@opentelemetry/instrumentation-xml-http-request': configDefaults,
            '@opentelemetry/instrumentation-fetch': configDefaults,
            '@opentelemetry/instrumentation-document-load': configDefaults,
            '@opentelemetry/instrumentation-user-interaction': {enabled: true}
          }),
        ],
      });
      apiRef.start();
    } catch (e) {
      console.log(`rendering... ${new Date().toISOString()}`);
      console.error(e);
      // fail silently in log but let the UI keep on moving
    }
    // render nothing, just use this to instrument
    return null;
}
