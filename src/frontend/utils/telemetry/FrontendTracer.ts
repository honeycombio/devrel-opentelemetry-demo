// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

'use client';

import {HoneycombWebSDK} from "@honeycombio/opentelemetry-web";
import {getWebAutoInstrumentations} from "@opentelemetry/auto-instrumentations-web";
import {useRef} from "react";
import {ZoneContextManager} from "@opentelemetry/context-zone";

// we need to only run this on the client, actions like SSR will fail with an error
const componentType = typeof window === 'undefined' ? 'server' : 'client';

const configDefaults = {
  ignoreNetworkEvents: true
}

export default function FrontendTracer() {
  console.log(`I am rendering in ${typeof window === 'undefined' ? 'server' : 'window'}`)

  const apiRef = useRef<HoneycombWebSDK| null>(null);

  // if not on client check 2
  if (componentType === 'server') {
    console.log('Ken checks - did we try to ssr this client component? Abort early.');
    return null;
  }

  if (!apiRef.current) {
    try {
      // doesn't specify SDK endpoint, defaults to us v1/traces endpoint
      apiRef.current = new HoneycombWebSDK({
        contextManager: new ZoneContextManager(),
        endpoint: '/otlp-http/v1/traces',
        serviceName: 'frontend-web',
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
      apiRef.current.start();
    } catch (e) {
      console.log(`rendering... ${new Date().toISOString()}`);
      console.error(e);
      // fail silently to the UI but keep on truckin'
      return null;
    }
    // render nothing
    return null;
  }
}