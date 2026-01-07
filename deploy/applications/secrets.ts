import * as pulumi from "@pulumi/pulumi";
import { Secret } from "@pulumi/kubernetes/core/v1/secret";
import { DeploymentConfig } from "../config";

export interface HoneycombSecretsArgs {
    namespace: pulumi.Input<string>;
    config: DeploymentConfig;
}

export class HoneycombSecrets extends pulumi.ComponentResource {
    public readonly prodSecret: Secret;
    public readonly dogfoodSecret: Secret;

    constructor(name: string,
        args: HoneycombSecretsArgs,
        opts: pulumi.ComponentResourceOptions = {}) {
        super("devrel:honeycomb-secrets", name, args, opts);

        this.prodSecret = new Secret(`${name}-prod`, {
            metadata: {
                name: "honeycomb-api",
                namespace: args.namespace
            },
            stringData: {
                ["honeycomb-api-key"]: args.config.honeycombProdApiKey
            }
        }, { provider: opts.provider!, parent: this });

        this.dogfoodSecret = new Secret(`${name}-dogfood`, {
            metadata: {
                name: "honeycomb-api-dogfood",
                namespace: args.namespace
            },
            stringData: {
                ["honeycomb-api-key"]: args.config.honeycombDogfoodApiKey
            }
        }, { provider: opts.provider!, parent: this });
    }
}

