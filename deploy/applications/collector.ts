import * as pulumi from "@pulumi/pulumi";
import { Secret } from "@pulumi/kubernetes/core/v1";
import { Release } from "@pulumi/kubernetes/helm/v3";

export interface CollectorArgs {
    collectorHelmVersion: pulumi.Input<string>;
    namespace: pulumi.Input<string>;
    honeycombSecret: Secret;
    honeycombDogfoodSecret: Secret;
    valuesFile: string;
}

export class Collector extends pulumi.ComponentResource {

    public readonly collectorName: pulumi.Output<string>;

    constructor(name: string,
        args: CollectorArgs,
        opts: pulumi.ComponentResourceOptions = {}) {
        super("devrel:collector", name, args, opts);


        const values = {
            "extraEnvs": [
                {
                    "name": "HONEYCOMB_API_KEY",
                    "valueFrom": {
                        "secretKeyRef": {
                            "name": args.honeycombSecret.id.apply(id => id.split("/")[1]),
                            "key": "honeycomb-api-key"
                        }
                    }
                },
                {
                    "name": "HONEYCOMB_API_KEY_DOGFOOD",
                    "valueFrom": {
                        "secretKeyRef": {
                            "name": args.honeycombDogfoodSecret.id.apply(id => id.split("/")[1]),
                            "key": "honeycomb-api-key"
                        }
                    }
                }
            ]
        }

        const collectorRelease = new Release(`${name}-release`, {
            chart: "opentelemetry-collector",
            name: name,
            version: args.collectorHelmVersion,
            repositoryOpts: {
                repo: "https://open-telemetry.github.io/opentelemetry-helm-charts"
            },
            dependencyUpdate: true,
            namespace: args.namespace,
            values: values,
            valueYamlFiles: [new pulumi.asset.FileAsset(args.valuesFile)]
        }, { provider: opts.provider! });

        this.collectorName = pulumi.interpolate `${collectorRelease.name}-opentelemetry-collector.${collectorRelease.namespace}`;

    }
}