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

const sdk = new otelsdk.NodeSDK({
  traceExporter: new OTLPTraceExporter(),
//  logRecordProcessor: new otelsdk.logs.BatchLogRecordProcessor(new OTLPLogExporter()),
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
