import * as pulumi from "@pulumi/pulumi";
import { Release } from "@pulumi/kubernetes/helm/v3";
import { Secret } from "@pulumi/kubernetes/core/v1";

export interface TelemetryPipelineArgs {
    namespace: pulumi.Input<string>;
    pipelineHoneycombApiKey: pulumi.Input<string>;
    pipelineHoneycombManagementApiKey: pulumi.Input<string>;
    pipelineHoneycombManagementApiKeyId: pulumi.Input<string>;
    useDogfood: pulumi.Input<boolean>;
}

export class TelemetryPipeline extends pulumi.ComponentResource {

    constructor(name: string,
        args: TelemetryPipelineArgs,
        opts: pulumi.ComponentResourceOptions = {}) {
        super("devrel:telemetry-pipeline", name, args, opts);

        const secretApiKey = new Secret(`${name}-pipeline-api-keys`, {
            metadata: {
                name: "honeycomb-observability-pipeline",
                namespace: args.namespace
            },
            stringData: {
                ["api-key"]: args.pipelineHoneycombApiKey,
                ["management-api-secret"]: args.pipelineHoneycombManagementApiKey
            }
        }, { provider: opts.provider! })

        const values = {
            "beekeeper": {
                "team": "devrel-telemetry-pipeline",
                "pipelineInstallationID": "hccpi_01jp5baph0be20rje3pyaxeegh",
                "publicMgmtKey": `${args.pipelineHoneycombManagementApiKeyId}`,
                "telemetry": {
                    "enabled": true,
                    "config": {
                        "tracer_provider": {
                            "processors": [
                                {
                                    "batch": {
                                        "exporter": {
                                            "otlp": {
                                                "protocol": "http/protobuf",
                                                "endpoint": "${TELEMETRY_ENDPOINT}",
                                                "headers": [
                                                    {
                                                        "name": "x-honeycomb-team",
                                                        "value": "${HONEYCOMB_API_KEY}"
                                                    }
                                                ]
                                            }
                                        }
                                    }
                                }
                            ]
                        },
                        "logger_provider": {
                            "processors": [
                                {
                                    "batch": {
                                        "exporter": {
                                            "otlp": {
                                                "protocol": "http/protobuf",
                                                "endpoint": "${TELEMETRY_ENDPOINT}",
                                                "headers": [
                                                    {
                                                        "name": "x-honeycomb-team",
                                                        "value": "${HONEYCOMB_API_KEY}"
                                                    }
                                                ]
                                            }
                                        }
                                    }
                                }
                            ]
                        }
                    }
                }
            },
            "collector": {
                "image": {
                    "repository": "mainacra1e0ec0b.azurecr.io/hny/opampsupervisor",
                    "tag": "latest"
                }
            }
        };

        const dogfoodOverrides = {
            "refinery": {
                "config": {
                    "Network": {
                        "HoneycombAPI": "https://api-dogfood.honeycomb.io"
                    },
                    "HoneycombLogger": {
                        "Dataset": "refinery-logs",
                        "APIHost": "https://api-dogfood.honeycomb.io"
                    },
                    "OTelMetrics": {
                        "Dataset": "refinery-metrics",
                        "APIHost": "https://api-dogfood.honeycomb.io"
                    }
                }
            },
            "opampsupervisor": {
                "telemetry": {
                    "defaultEndpoint": "https://api-dogfood.honeycomb.io"
                } 
            },
            "beekeeper": {
                "endpoint": "https://api-dogfood.honeycomb.io",
                "defaultEnv": {
                    "TELEMETRY_ENDPOINT":{
                        "content": {
                            value: "https://api-dogfood.honeycomb.io",
                        }
                    }
                },
            }
        };

        let mergedValues = values;
    
        if (args.useDogfood) {
            mergedValues = {
                ...values,
                ...dogfoodOverrides,
                beekeeper: {
                    ...values.beekeeper,
                    ...dogfoodOverrides.beekeeper
                },
            };
        }

        const pipelineRelease = new Release(`${name}-pipeline-release`, {
            chart: "observability-pipeline",
            name: name,
            version: "0.0.23-alpha",
            repositoryOpts: {
                repo: "https://honeycombio.github.io/helm-charts"
            },
            dependencyUpdate: true,
            namespace: args.namespace,
            values: mergedValues,
            valueYamlFiles: [new pulumi.asset.FileAsset("./config-files/demo/values.yaml")]
        }, { provider: opts.provider! });
    }
}
