// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

import '../styles/globals.css';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App, { AppContext, AppProps } from 'next/app';
import CurrencyProvider from '../providers/Currency.provider';
import CartProvider from '../providers/Cart.provider';
import { ThemeProvider } from 'styled-components';
import Theme from '../styles/Theme';
import FrontendTracer from '../utils/telemetry/FrontendTracer';
import { OpenFeature, OpenFeatureProvider } from '@openfeature/react-sdk';
import SessionGateway from '../gateways/Session.gateway';
import { FlagdWebProvider } from '@openfeature/flagd-web-provider';
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

if (typeof window  !== 'undefined' && window.location) {
    const session = SessionGateway.getSession();
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

const queryClient = new QueryClient();

function MyApp({ Component, pageProps }: AppProps) {
    // woe betide anyone who gets a 423 or 425 React minified error. This is caused by
    // something changing within the component during initial server render, which makes
    // it look different than client-side. The quick fix for this page is to just defer
    // full-blown app creation until we hit the client, where session exists.
    // It works, but I'm not happy about it. Compared many things but could not find
    // the causes.
    const [started, setStarted] = useState(false);
    useEffect(() => {
        setStarted(true);
    }, []);
    return (
        <>
            <FrontendTracer />
            { started &&
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
            }
        </>
    );
}

MyApp.getInitialProps = async (appContext: AppContext) => {
    const appProps = await App.getInitialProps(appContext);

    return { ...appProps };
};

export default MyApp;
