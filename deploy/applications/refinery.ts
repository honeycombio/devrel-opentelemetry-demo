import * as pulumi from "@pulumi/pulumi";
import { Release } from "@pulumi/kubernetes/helm/v3";
import { Ingress } from "@pulumi/kubernetes/networking/v1/ingress";
import { CustomResource } from "@pulumi/kubernetes/apiextensions";
import { Secret } from "@pulumi/kubernetes/core/v1/secret";
import { ConfigMap } from "@pulumi/kubernetes/core/v1/configMap";

export interface RefineryArgs {
    domainName: pulumi.Input<string>;
    namespace: pulumi.Input<string>;
    collectorHostName: pulumi.Output<string>;
    demoVersion: pulumi.Input<string>;
    ingressClassName: pulumi.Input<string>;
    containerTag: pulumi.Input<string>;
    telemetryApiKey: pulumi.Input<string>;
}

export class Refinery extends pulumi.ComponentResource {

    public readonly domainName: pulumi.Output<string>;

    constructor(name: string,
        args: RefineryArgs,
        opts: pulumi.ComponentResourceOptions = {}) {
        super("devrel:Refinery", name, args, opts);


        const refineryTelemetryApiKeySecret = new Secret(`${name}-telemetry-api-key`, {
            metadata: {
                name: "refinery-telemetry-api-key",
                namespace: args.namespace
            },
            stringData: {
                ["honeycomb-api-key"]: args.telemetryApiKey
            }
        }, { provider: opts.provider! });

        const refineryRulesConfigMap = new ConfigMap(`${name}-rules-config-map`, {
            metadata: {
                name: "refinery-rules-config-map",
                namespace: args.namespace
            },
            data: {
                ["rules.yaml"]: `rules:`
            }
        }, { provider: opts.provider! });

        const values =
        {
            "environment": [
                {
                    "name": "REFINERY_HONEYCOMB_API_KEY",
                    "valueFrom": {
                        "secretKeyRef": {
                            "name": refineryTelemetryApiKeySecret.id.apply(id => id.split("/")[1]),
                            "key": "honeycomb-api-key"
                        }
                    }
                }
            ],

        };

        // new Dictionary<string, object> {
        //     ["environment"] = new [] {
        //         new Dictionary<string, object> {
        //             ["name"] = "REFINERY_HONEYCOMB_API_KEY",
        //             ["valueFrom"] = new Dictionary<string, object> {
        //                 ["secretKeyRef"] = new Dictionary<string, object> {
        //                     ["name"] = secretApiKey.Id.Apply(a => a.Split("/")[1]),
        //                     ["key"] = "honeycomb-api-key"
        //                 }
        //             }
        //         }
        //     },
        //     ["RulesConfigMapName"] = refineryRulesConfigMap.Metadata.Apply(m => m.Name)
        // }


        var refinery = new Release("refinery", {
            chart: "refinery",
            name: "refinery",
            namespace: args.namespace,
            repositoryOpts = {
                repo = "https://honeycombio.github.io/helm-charts"
            },
            valueYamlFiles = new FileAsset("./config-files/refinery/values.yaml"),
            values = values,
        }, { provider = arg.Provider!});

    }
}