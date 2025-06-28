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

## Deployment

### Tagging Releases

To deploy the demo application, create a git tag and push it:

```bash
# Create and push a new release tag
git tag -a v1.2.3 -m "Release version 1.2.3"
git push origin v1.2.3

# Or create a lightweight tag
git tag v1.2.3
git push origin v1.2.3
```

The deployment pipeline will automatically deploy tagged releases to the production environment at https://zurelia.honeydemo.io.
