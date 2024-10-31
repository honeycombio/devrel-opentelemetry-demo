// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

import '../styles/globals.css';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App, { AppContext, AppProps } from 'next/app';
import { getCookie } from 'cookies-next';
import CurrencyProvider from '../providers/Currency.provider';
import CartProvider from '../providers/Cart.provider';
import { ThemeProvider } from 'styled-components';
import Theme from '../styles/Theme';
import FrontendTracer from '../utils/telemetry/FrontendTracer';
import SessionGateway from '../gateways/Session.gateway';
import { OpenFeatureProvider, OpenFeature } from '@openfeature/react-sdk';
import { FlagdWebProvider } from '@openfeature/flagd-web-provider';
import {HoneycombWebSDK} from "@honeycombio/opentelemetry-web";
import {getWebAutoInstrumentations} from "@opentelemetry/auto-instrumentations-web";

declare global {
  interface Window {
    ENV: {
      NEXT_PUBLIC_PLATFORM?: string;
      NEXT_PUBLIC_OTEL_SERVICE_NAME?: string;
      NEXT_PUBLIC_OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?: string;
      IS_SYNTHETIC_REQUEST?: string;
    };
  }
}

if (typeof window !== 'undefined') {
    const configDefaults = {
        ignoreNetworkEvents: true,
        // propagateTraceHeaderCorsUrls: [
        // /.+/g, // Regex to match your backend URLs. Update to the domains you wish to include.
        // ]
    };

    console.log('************ booting the front-end');
    const sdk = new HoneycombWebSDK({
        endpoint: "http://localhost:9191/oltp-http/v1/traces", // Send to EU instance of Honeycomb. Defaults to sending to US instance.
        debug: true, // Set to false for production environment.
        // TODO - pull from env
        apiKey: process.env.NEXT_PUBLIC_HONEYCOMB_API_KEY, // Replace with your Honeycomb Ingest API Key.
        serviceName: 'frontend-web', // Replace with your application name. Honeycomb uses this string to find your dataset when we receive your data. When no matching dataset exists, we create a new one with this name if your API Key has the appropriate permissions.
        instrumentations: [getWebAutoInstrumentations({
            // Loads custom configuration for xml-http-request instrumentation.
            '@opentelemetry/instrumentation-xml-http-request': configDefaults,
            '@opentelemetry/instrumentation-fetch': configDefaults,
            '@opentelemetry/instrumentation-document-load': configDefaults,
        })],
    });
    sdk.start();
  // if (window.location) {
  //   const session = SessionGateway.getSession();
  //
  //   // Set context prior to provider init to avoid multiple http calls
  //   OpenFeature.setContext({ targetingKey: session.userId, ...session }).then(() => {
  //     /**
  //      * We connect to flagd through the envoy proxy, straight from the browser,
  //      * for this we need to know the current hostname and port.
  //      */
  //
  //     const useTLS = window.location.protocol === 'https:';
  //     let port = useTLS ? 443 : 80;
  //     if (window.location.port) {
  //         port = parseInt(window.location.port, 10);
  //     }
  //
  //     OpenFeature.setProvider(
  //       new FlagdWebProvider({
  //         host: window.location.hostname,
  //         pathPrefix: 'flagservice',
  //         port: port,
  //         tls: useTLS,
  //         maxRetries: 3,
  //         maxDelay: 10000,
  //       })
  //     );
  //   });
  // }
}

const queryClient = new QueryClient();

function MyApp({ Component, pageProps }: AppProps) {
  return (
    <ThemeProvider theme={Theme}>
      <OpenFeatureProvider>
        <QueryClientProvider client={queryClient}>
          <CurrencyProvider>
            <CartProvider>
              <Component {...pageProps} />
            </CartProvider>
          </CurrencyProvider>
        </QueryClientProvider>
      </OpenFeatureProvider>
    </ThemeProvider>
  );
}

MyApp.getInitialProps = async (appContext: AppContext) => {
  const appProps = await App.getInitialProps(appContext);

  return { ...appProps };
};

export default MyApp;
