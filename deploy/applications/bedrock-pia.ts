import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { DeploymentConfig } from "../config";

export interface BedrockPodIdentityAssociationArgs {
    config: DeploymentConfig;
    namespace: pulumi.Input<string>;
    serviceAccountName: pulumi.Input<string>;
}

/**
 * Creates an EKS Pod Identity Association granting the shared Bedrock IAM role
 * (from the infra-aws stack) to a Kubernetes service account.
 */
export class BedrockPodIdentityAssociation extends pulumi.ComponentResource {
    public readonly associationId: pulumi.Output<string>;

    constructor(name: string,
        args: BedrockPodIdentityAssociationArgs,
        opts: pulumi.ComponentResourceOptions = {}) {
        super("devrel:bedrock-pod-identity-association", name, args, opts);

        const clusterName = args.config.infraStack.getOutput("clusterName") as pulumi.Output<string>;
        const bedrockRoleArn = args.config.infraStack.getOutput("bedrockRoleArn") as pulumi.Output<string>;

        const association = new aws.eks.PodIdentityAssociation(`${name}-association`, {
            clusterName: clusterName,
            namespace: args.namespace,
            serviceAccount: args.serviceAccountName,
            roleArn: bedrockRoleArn,
        }, { parent: this });

        this.associationId = association.associationId;

        this.registerOutputs({
            associationId: this.associationId,
        });
    }
}
