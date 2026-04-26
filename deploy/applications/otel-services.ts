import * as pulumi from "@pulumi/pulumi";
import { Release } from "@pulumi/kubernetes/helm/v3";
import { DeploymentConfig } from "../config";

export interface OtelServicesArgs {
    config: DeploymentConfig;
    namespace: pulumi.Input<string>;
    collectorName: pulumi.Output<string>;
}

/**
 * Deploys the otel-services Helm chart (storechat, llm-evals, product-reviews, llm).
 * The Helm release is named "otel-services", which means the Kubernetes ServiceAccount
 * will also be named "otel-services" — matching the BedrockPodIdentityAssociation.
 */
export class OtelServices extends pulumi.ComponentResource {

    constructor(name: string,
        args: OtelServicesArgs,
        opts: pulumi.ComponentResourceOptions = {}) {
        super("devrel:otel-services", name, args, opts);

        const bedrockProfiles = args.config.infraStack.getOutput("bedrockProdProfiles") as pulumi.Output<Record<string, string>>;
        const bedrockHaikuProfileArn = bedrockProfiles.apply(p => p.claudeHaiku);
        const clusterRegion = args.config.infraStack.getOutput("clusterRegion") as pulumi.Output<string>;

        const values: Record<string, unknown> = {
            services: {
                storechat: {
                    enabled: true,
                    image: {
                        tag: `${args.config.containerTag}-storechat`,
                    },
                    awsRegion: clusterRegion,
                    bedrockHaikuProfileArn: bedrockHaikuProfileArn,
                    kafkaAddr: 'kafka:9092',
                },
                llmEvals: {
                    enabled: true,
                    image: {
                        tag: `${args.config.containerTag}-llm-evals`,
                    },
                    awsRegion: clusterRegion,
                    bedrockHaikuProfileArn: bedrockHaikuProfileArn,
                    kafkaAddr: 'kafka:9092',
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
            // Default is 300s; a slow-to-ready pod would then abort the whole
            // release and can leave pulumi state with a malformed secret marker
            // (we hit this on the 2.5.0-release deploy). 30 min is generous.
            timeout: 1800,
        }, { parent: this, provider: opts.provider! });

        this.registerOutputs({});
    }
}
