import * as pulumi from "@pulumi/pulumi";
import { Release } from "@pulumi/kubernetes/helm/v3";
import { Secret } from "@pulumi/kubernetes/core/v1/secret";
import { ConfigMap } from "@pulumi/kubernetes/core/v1/configMap";
import * as fs from "fs";

export interface RefineryArgs {
    namespace: pulumi.Input<string>;
    telemetryApiKey: pulumi.Input<string>;
}

export class Refinery extends pulumi.ComponentResource {

    public readonly refineryHostname: pulumi.Output<string>;

    constructor(name: string,
        args: RefineryArgs,
        opts: pulumi.ComponentResourceOptions = {}) {
        super("devrel:refinery", name, args, opts);


        const refineryTelemetryApiKeySecret = new Secret(`${name}-telemetry-api-key`, {
            metadata: {
                name: "refinery-telemetry-api-key",
                namespace: args.namespace
            },
            stringData: {
                ["honeycomb-api-key"]: args.telemetryApiKey
            }
        }, { provider: opts.provider! });

        // load ./config-files/refinery/rules.yaml
        const rules = new ConfigMap(`${name}-rules`, {
            metadata: {
                namespace: args.namespace
            },
            data: {
                "rules.yaml": fs.readFileSync("./config-files/refinery/rules.yaml", 'utf8') 
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
            "RulesConfigMapName": rules.metadata.name
        };


        var refinery = new Release("refinery", {
            chart: "refinery",
            name: "refinery",
            namespace: args.namespace,
            repositoryOpts: {
                repo: "https://honeycombio.github.io/helm-charts"
            },
            valueYamlFiles: [new pulumi.asset.FileAsset("./config-files/refinery/values.yaml")],
            values: values,
        }, { provider: opts.provider!});

        this.refineryHostname = pulumi.interpolate `${args.namespace}.${refinery.name}`;
    }

}