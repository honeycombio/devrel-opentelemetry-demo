import * as pulumi from "@pulumi/pulumi";
import { Secret } from "@pulumi/kubernetes/core/v1/secret";
import { Release } from "@pulumi/kubernetes/helm/v3";
import { DeploymentConfig } from "../config";

export interface HtpBuilderArgs {
    config: DeploymentConfig;
    namespace: pulumi.Input<string>;
}

export class HtpBuilder extends pulumi.ComponentResource {
    public readonly releaseName: pulumi.Output<string>;

    constructor(name: string,
        args: HtpBuilderArgs,
        opts: pulumi.ComponentResourceOptions = {}) {
        super("devrel:htp-builder", name, args, opts);

        const htpConfig = args.config.htpBuilderConfig;

        // Create the htp-builder secret with management API key and pipeline telemetry key
        const htpBuilderSecret = new Secret(`${name}-secret`, {
            metadata: {
                name: "htp-builder",
                namespace: args.namespace
            },
            stringData: {
                ["management-api-secret"]: htpConfig.managementApiKeySecret,
                ["pipeline-telemetry-key"]: htpConfig.pipelineTelemetryKey
            }
        }, { provider: opts.provider!, parent: this });

        const values = {
            "pipeline": {
                "id": htpConfig.pipelineId
            },
            "managementApiKey": {
                "id": htpConfig.managementApiKeyId
            }
        };

        const htpRelease = new Release(`${name}-release`, {
            chart: "htp-builder",
            name: name,
            version: args.config.versions.htpBuilderHelmVersion,
            repositoryOpts: {
                repo: "https://honeycombio.github.io/helm-charts"
            },
            namespace: args.namespace,
            values: values
        }, { provider: opts.provider!, parent: this, dependsOn: [htpBuilderSecret] });

        this.releaseName = htpRelease.name;
    }
}

