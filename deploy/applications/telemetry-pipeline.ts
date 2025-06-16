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

        const values = {
            "pipeline":{
                "id": "hcapi_01jwdym5sqvsk1w7pc0z2687rs"
            },
            "managementApiKey": {
                "id": `${args.pipelineHoneycombManagementApiKeyId}`
            },
            "refinery": {
                "replicaCount": 2
            }
        };
    
        const pipelineRelease = new Release(`${name}-pipeline-release`, {
            chart: "htp-builder",
            name: name,
            version: "0.0.70-alpha",
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
