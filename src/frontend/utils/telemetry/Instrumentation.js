// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

const otelsdk = require('@opentelemetry/sdk-node');
const opentelemetry = require('@opentelemetry/api');
const {getNodeAutoInstrumentations} = require('@opentelemetry/auto-instrumentations-node');
const {OTLPTraceExporter} = require('@opentelemetry/exporter-trace-otlp-grpc');
const { OTLPLogExporter } = require('@opentelemetry/exporter-logs-otlp-http');
const {awsEc2Detector, awsEksDetector} = require('@opentelemetry/resource-detector-aws');
const {containerDetector} = require('@opentelemetry/resource-detector-container');
const {gcpDetector} = require('@opentelemetry/resource-detector-gcp');
const {envDetector, hostDetector, osDetector, processDetector} = require('@opentelemetry/resources');

// console.log("Otel, tell me wtf you are doing")
// opentelemetry.diag.setLogger(
//   new opentelemetry.DiagConsoleLogger(),
//   opentelemetry.DiagLogLevel.INFO
// );

console.log("Instrumenting node with otel");
const sdk = new otelsdk.NodeSDK({
  // n.b. - the service for the next.js backend is being
  // sent to Honeycomb as 'api-gateway' - this is done
  // in our collector. Don't bother to set the serviceName
  // here!

  traceExporter: new OTLPTraceExporter({
    url: '/otlp-http/v1/traces'
  }),
  logRecordProcessor: new otelsdk.logs.BatchLogRecordProcessor(new OTLPLogExporter()),
  instrumentations: [
    getNodeAutoInstrumentations({
      // disable fs instrumentation to reduce noise
      '@opentelemetry/instrumentation-fs': {
        enabled: false,
      },
      '@opentelemetry/instrumentation-http': {
        enabled: false,
      },
    })
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
  ],
});

sdk.start();
