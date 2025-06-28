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

#### Tag Naming Convention

Use the format `X.Y.Z-release` where:

- `X.Y.Z` follows semantic versioning (major.minor.patch)
- Always append `-release` suffix

Examples of existing tags:

- `2.0.26-release`
- `2.0.27-release`

#### Creating and Pushing Tags

ONLY DO THIS IF EXPLICITLY ASKED TO

```bash
# Check current latest release tag
git tag -l "*-release" | sort -V | tail -1

# Create and push a new release tag (increment appropriately)
git tag 2.0.28-release
git push origin 2.0.28-release
```

The deployment pipeline will automatically deploy tagged releases to the production environment at https://zurelia.honeydemo.io.

See status: https://github.com/honeycombio/devrel-opentelemetry-demo/actions
