import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { DeploymentConfig } from "../config";

export interface PodIdentityAssociationArgs {
    config: DeploymentConfig;
    namespace: pulumi.Input<string>;
    serviceAccountName: pulumi.Input<string>;
}

/**
 * Creates an EKS Pod Identity Association to grant AWS IAM role permissions
 * to a Kubernetes service account.
 */
export class PodIdentityAssociation extends pulumi.ComponentResource {
    public readonly associationId: pulumi.Output<string>;

    constructor(name: string,
        args: PodIdentityAssociationArgs,
        opts: pulumi.ComponentResourceOptions = {}) {
        super("devrel:pod-identity-association", name, args, opts);

        const clusterName = args.config.infraStack.getOutput("clusterName") as pulumi.Output<string>;
        const s3RoleArn = args.config.infraStack.getOutput("s3RoleArn") as pulumi.Output<string>;

        const association = new aws.eks.PodIdentityAssociation(`${name}-association`, {
            clusterName: clusterName,
            namespace: args.namespace,
            serviceAccount: args.serviceAccountName,
            roleArn: s3RoleArn
        }, { parent: this });

        this.associationId = association.associationId;

        this.registerOutputs({
            associationId: this.associationId
        });
    }
}

