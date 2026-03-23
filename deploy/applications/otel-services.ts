import * as pulumi from "@pulumi/pulumi";
import { Release } from "@pulumi/kubernetes/helm/v3";
import { DeploymentConfig } from "../config";

export interface OtelServicesArgs {
    config: DeploymentConfig;
    namespace: pulumi.Input<string>;
    collectorName: pulumi.Output<string>;
}

/**
 * Deploys the otel-services Helm chart (chatbot, llm-evals, product-reviews, llm).
 * The Helm release is named "otel-services", which means the Kubernetes ServiceAccount
 * will also be named "otel-services" — matching the BedrockPodIdentityAssociation.
 */
export class OtelServices extends pulumi.ComponentResource {

    constructor(name: string,
        args: OtelServicesArgs,
        opts: pulumi.ComponentResourceOptions = {}) {
        super("devrel:otel-services", name, args, opts);

        const bedrockHaikuProfileArn = args.config.infraStack.getOutput("bedrockClaudeHaikuProfileArn") as pulumi.Output<string>;
        const bedrockSonnetProfileArn = args.config.infraStack.getOutput("bedrockClaudeSonnetProfileArn") as pulumi.Output<string>;
        const clusterRegion = args.config.infraStack.getOutput("clusterRegion") as pulumi.Output<string>;

        const values: Record<string, unknown> = {
            services: {
                chatbot: {
                    enabled: true,
                    image: {
                        tag: `${args.config.containerTag}-chatbot`,
                    },
                    awsRegion: clusterRegion,
                    bedrockHaikuProfileArn: bedrockHaikuProfileArn,
                    bedrockSonnetProfileArn: bedrockSonnetProfileArn,
                },
                // product-reviews and llm are deployed directly by Pulumi in oteldemo.ts
                productReviews: { enabled: false },
                llm: { enabled: false },
            },
            otel: {
                collectorName: args.collectorName,
            },
        };

        new Release(`${name}-release`, {
            chart: "../skaffold-config/charts/otel-services",
            name: "otel-services",
            namespace: args.namespace,
            values: values,
        }, { parent: this, provider: opts.provider! });

        this.registerOutputs({});
    }
}
