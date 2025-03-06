// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

// this script is called automatically by Next.js when starting the server
// and is used to instrument the Node.js/runtime side of Next.js
// see the start script in package.json for usage.
// YMMV if you are using Vercel's hosting for example, you may need to tweak the
// settings. I have not tested that.

const  otelsdk = require('@opentelemetry/sdk-node');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');

// The Next.js server side is using GRPC to export traces
const {OTLPTraceExporter} = require('@opentelemetry/exporter-trace-otlp-grpc');

// if using logs
// const { OTLPLogExporter } = require('@opentelemetry/exporter-logs-otlp-grpc');

const { awsEc2Detector, awsEksDetector } = require('@opentelemetry/resource-detector-aws');
const { containerDetector } = require('@opentelemetry/resource-detector-container');
const { gcpDetector } = require('@opentelemetry/resource-detector-gcp');
const { envDetector, hostDetector, osDetector, processDetector } = require('@opentelemetry/resources');
const { BunyanInstrumentation } = require('@opentelemetry/instrumentation-bunyan');
const os = require('os');

// console.log("Otel, tell me wtf you are doing")
// opentelemetry.diag.setLogger(
//   new opentelemetry.DiagConsoleLogger(),
//   opentelemetry.DiagLogLevel.INFO
// );

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

console.log('I am running on the server side. ' + os.hostname());
console.log('Registering OpenTelemetry Node SDK');
// Uses OTEL environment variables defined in .env for this demo. See .env-sample
// for setting up your own instance.

const sdk = new otelsdk.NodeSDK({
  // n.b. - the service for the next.js backend is being
  // sent to Honeycomb as 'api-gateway' - this is done
  // in our collector. Don't bother to set the serviceName
  // here!

  traceExporter: new OTLPTraceExporter({
    url: endpoint,
  }),
  // enable to get log records
  // logRecordProcessor: new otelsdk.logs.BatchLogRecordProcessor(new OTLPLogExporter()),
  instrumentations: [
    getNodeAutoInstrumentations({
      // disable fs instrumentation to reduce noise
      '@opentelemetry/instrumentation-fs': {
        enabled: false,
      },
      '@opentelemetry/instrumentation-http': {
        enabled: false,
      },
    }),
    new BunyanInstrumentation(),
  ],
  resourceDetectors: [
    containerDetector,
    envDetector,
    hostDetector,
    osDetector,
    processDetector,
    awsEksDetector,
    awsEc2Detector,
    gcpDetector,
  ]
});

try {
  sdk.start();
  console.log('backend OpenTelemetry SDK started');
} catch (e) {
  console.error('Failed to start OpenTelemetry SDK');
  console.error(e);
}