import * as pulumi from "@pulumi/pulumi";
import { Release } from "@pulumi/kubernetes/helm/v3";
import { Secret } from "@pulumi/kubernetes/core/v1";

export interface TelemetryPipelineArgs {
    namespace: pulumi.Input<string>;
    pipelineHoneycombApiKey: pulumi.Input<string>;
    pipelineHoneycombManagementApiKey: pulumi.Input<string>;
    pipelineHoneycombManagementApiKeyId: pulumi.Input<string>;
    useDogfood: pulumi.Input<boolean>;
    s3AccessKey: pulumi.Input<string>;
    s3SecretKey: pulumi.Input<string>;
}

export class TelemetryPipeline extends pulumi.ComponentResource {

    public readonly releaseName: pulumi.Output<string>;

    constructor(name: string,
        args: TelemetryPipelineArgs,
        opts: pulumi.ComponentResourceOptions = {}) {
        super("devrel:telemetry-pipeline", name, args, opts);

        const secretApiKey = new Secret(`${name}-pipeline-api-keys`, {
            metadata: {
                name: "htp-builder",
                namespace: args.namespace
            },
            stringData: {
                ["api-key"]: args.pipelineHoneycombApiKey,
                ["management-api-secret"]: args.pipelineHoneycombManagementApiKey
            }
        }, { provider: opts.provider! })

        const awsCredentials = new Secret(`${name}-aws-credentials`, {
            metadata: {
                name: "s3-aws-credentials",
                namespace: args.namespace
            },
            stringData: {
                ["aws-access-key-id"]: args.s3AccessKey,
                ["aws-secret-access-key"]: args.s3SecretKey
            }
        }, { provider: opts.provider! })

        const values = {
            "pipeline":{
                "id": "hcapi_01jwdym5sqvsk1w7pc0z2687rs"
            },
            "managementApiKey": {
                "id": `${args.pipelineHoneycombManagementApiKeyId}`
            },
            "refinery": {
                "replicaCount": 2
            },
            "primaryCollector": {
                "extraEnvs": [
                    {
                        "name": "AWS_ACCESS_KEY_ID",
                        "valueFrom": {
                            "secretKeyRef": {
                                "name": awsCredentials.metadata.name,
                                "key": "aws-access-key-id"
                            }
                        }
                    },
                    {
                        "name": "AWS_SECRET_ACCESS_KEY",
                        "valueFrom": {
                            "secretKeyRef": {
                                "name": awsCredentials.metadata.name,
                                "key": "aws-secret-access-key"
                            }
                        }
                    },
                    {
                        "name": "AWS_REGION",
                        "value": "us-west-1"
                    },
                    { 
                        "name": "AWS_EC2_METADATA_DISABLED",
                        "value": "true"
                    },
                    {
                        "name": "AWS_IMDS_DISABLED",
                        "value": "true"
                    }
                ]
            }
        };
    
        const pipelineRelease = new Release(`${name}-pipeline-release`, {
            chart: "htp-builder",
            name: name,
            version: "0.0.75-alpha",
            repositoryOpts: {
                repo: "https://honeycombio.github.io/helm-charts"
            },
            dependencyUpdate: true,
            namespace: args.namespace,
            values: values,
        }, { provider: opts.provider! });

        this.releaseName = pulumi.interpolate `${pipelineRelease.name}-${pipelineRelease.chart}`;
    }
}
