// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0


// eslint-disable-next-line @typescript-eslint/no-var-requires
const dotEnv = require('dotenv');

// eslint-disable-next-line @typescript-eslint/no-var-requires
const dotenvExpand = require('dotenv-expand');

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resolve } = require('path');

// TODO - convert to Next.js 15 - and convert this implied typing and file to Typescript!
/** @type {import('next').NextConfig} */
const myEnv = dotEnv.config({
  path: resolve(__dirname, '../../.env'),
});

dotenvExpand.expand(myEnv);

const {
  AD_SERVICE_ADDR = '',
  CART_SERVICE_ADDR = '',
  CHECKOUT_SERVICE_ADDR = '',
  CURRENCY_SERVICE_ADDR = '',
  PRODUCT_CATALOG_SERVICE_ADDR = '',
  RECOMMENDATION_SERVICE_ADDR = '',
  SHIPPING_SERVICE_ADDR = '',
  ENV_PLATFORM = '',
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = '',
  OTEL_SERVICE_NAME = 'frontend',
} = process.env;

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'standalone',

  compiler: {
    styledComponents: true
  },
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve.fallback.http2 = false;
      config.resolve.fallback.tls = false;
      config.resolve.fallback.net = false;
      config.resolve.fallback.dns = false;
      config.resolve.fallback.fs = false;
    }
    return config;
  },
  env: {
    AD_SERVICE_ADDR,
    CART_SERVICE_ADDR,
    CHECKOUT_SERVICE_ADDR,
    CURRENCY_SERVICE_ADDR,
    PRODUCT_CATALOG_SERVICE_ADDR,
    RECOMMENDATION_SERVICE_ADDR,
    SHIPPING_SERVICE_ADDR,
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
    NEXT_PUBLIC_PLATFORM: ENV_PLATFORM,
    NEXT_PUBLIC_OTEL_SERVICE_NAME: OTEL_SERVICE_NAME,
  },
  images: {
    loader: "custom",
    loaderFile: "./utils/imageLoader.js"
  }
};

module.exports = nextConfig;
