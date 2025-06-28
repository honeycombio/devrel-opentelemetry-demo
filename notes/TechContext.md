# Technical Context

This is a microservices app that is gratuitously multilingual. Every service is instrumented with OpenTelemetry.

It is deployed at

https://zurelia.honeydemo.io

## Honeycomb Environments

The `azure-otel-demo-pipeline` environment contains multiple datasets, including three from HTP (Honeycomb Telemetry Pipeline):

- beekeeper
- opamp-supervisor
- primary-collector

## Calculated Fields

### cf.is_htp_dataset

A boolean calculated field that identifies which datasets come from Honeycomb Telemetry Pipeline (HTP).

- **Type**: Boolean
- **True for**: beekeeper, opamp-supervisor, primary-collector
- **False for**: All other datasets in the environment
- **Purpose**: Allows easy filtering and grouping of HTP vs application telemetry data
