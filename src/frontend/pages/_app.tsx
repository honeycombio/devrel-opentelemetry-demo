// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

import '../styles/globals.css';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App, { AppContext, AppProps } from 'next/app';
import CurrencyProvider from '../providers/Currency.provider';
import CartProvider from '../providers/Cart.provider';
import { ThemeProvider } from 'styled-components';
import Theme from '../styles/Theme';
import SessionGateway from '../gateways/Session.gateway';
import { OpenFeatureProvider, OpenFeature } from '@openfeature/react-sdk';
import { FlagdWebProvider } from '@openfeature/flagd-web-provider';
import HoneycombFrontendTracer from '../utils/telemetry/HoneycombFrontendTracer';
import { useEffect, useState } from 'react';

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

const reactQueryClient = new QueryClient({
    defaultOptions: {
        queries: {
            staleTime: 0,
            refetchOnWindowFocus: true,
            refetchOnMount: true,
        },
    },
});
function MyApp({ Component, pageProps }: AppProps) {
    const [hydrated, setHydrated] = useState(false);

    // this avoids a React hydration error.
    useEffect(() => {
      setHydrated(true);

      if (typeof window !== 'undefined') {
        if (window.location) {
          const session = SessionGateway.getSession();
          HoneycombFrontendTracer(session.userId);

          // Set context prior to provider init to avoid multiple http calls
          OpenFeature.setContext({ targetingKey: session.userId, ...session }).then(() => {
            /**
             * We connect to flagd through the envoy proxy, straight from the browser,
             * for this we need to know the current hostname and port.
             */

            const useTLS = window.location.protocol === 'https:';
            let port = useTLS ? 443 : 80;
            if (window.location.port) {
                port = parseInt(window.location.port, 10);
            }

            OpenFeature.setProvider(
              new FlagdWebProvider({
                host: window.location.hostname,
                pathPrefix: 'flagservice',
                port: port,
                tls: useTLS,
                maxRetries: 3,
                maxDelay: 10000,
              })
            );
          });
        }
      }
    }, []);

    if(!hydrated) {
      // this returns null on first render, so the client and server match
      return null;
    }

    return (
      <ThemeProvider theme={Theme}>
        <OpenFeatureProvider>
          <QueryClientProvider client={reactQueryClient}>
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
