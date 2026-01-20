import * as pulumi from "@pulumi/pulumi";
import { Release } from "@pulumi/kubernetes/helm/v3";
import { DeploymentConfig } from "../config";
import { HoneycombSecrets } from "./secrets";

export interface CollectorArgs {
    config: DeploymentConfig;
    namespace: pulumi.Input<string>;
    secrets: HoneycombSecrets;
    valuesFile: string;
    useCustomCollector: boolean;
    htpReleaseName?: pulumi.Input<string>;
}

export class Collector extends pulumi.ComponentResource {

    public readonly collectorName: pulumi.Output<string>;

    constructor(name: string,
        args: CollectorArgs,
        opts: pulumi.ComponentResourceOptions = {}) {
        super("devrel:collector", name, args, opts);


        const values = {
            "image": {
                "repository": args.useCustomCollector ? args.config.collectorContainerRepository : "ghcr.io/open-telemetry/opentelemetry-collector-releases/opentelemetry-collector-contrib",
                "tag": args.useCustomCollector ? args.config.collectorContainerTag : args.config.versions.defaultCollectorVersion
            },
            "extraEnvs": [
                {
                    "name": "HONEYCOMB_API_KEY",
                    "valueFrom": {
                        "secretKeyRef": {
                            "name": args.secrets.prodSecret.id.apply(id => id.split("/")[1]),
                            "key": "honeycomb-api-key"
                        }
                    }
                },
                {
                    "name": "HONEYCOMB_API_KEY_DOGFOOD",
                    "valueFrom": {
                        "secretKeyRef": {
                            "name": args.secrets.dogfoodSecret.id.apply(id => id.split("/")[1]),
                            "key": "honeycomb-api-key"
                        }
                    }
                },
                {
                    "name": "NAMESPACE",
                    "valueFrom": {
                        "fieldRef": {
                            "fieldPath": "metadata.namespace"
                        }
                    }
                },
                {
                    "name": "HTP_ENDPOINT",
                    "value": pulumi.interpolate `${args.htpReleaseName}-primary-collector:4317`
                },
            ]
        }

        const collectorRelease = new Release(`${name}-release`, {
            chart: "opentelemetry-collector",
            name: name,
            version: args.config.versions.collectorHelmVersion,
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