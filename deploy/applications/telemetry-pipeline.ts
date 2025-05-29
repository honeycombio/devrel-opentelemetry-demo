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
            "pipelineInstallationID": "hcapi_01jw9b92a3zqjm802dywqvxm4n",
            "publicMgmtAPIKey": `${args.pipelineHoneycombManagementApiKeyId}`,
        };
    
        const pipelineRelease = new Release(`${name}-pipeline-release`, {
            chart: "observability-pipeline",
            name: name,
            version: "0.0.53-alpha",
            devel: true,
            repositoryOpts: {
                repo: "https://honeycombio.github.io/helm-charts"
            },
            dependencyUpdate: true,
            namespace: args.namespace,
            values: values,
        }, { provider: opts.provider! });
    }
}
