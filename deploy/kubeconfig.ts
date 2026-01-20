import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { listManagedClusterUserCredentialsOutput } from "@pulumi/azure-native/containerservice";
import { DeploymentConfig } from "./config";

/**
 * Gets the kubeconfig for the target Kubernetes cluster based on the cloud provider.
 */
export function getKubeconfig(config: DeploymentConfig): pulumi.Output<string> {
    if (config.isAzure) {
        const clusterResourceGroup = config.infraStack.getOutput("clusterResourceGroup");
        const clusterName = config.infraStack.getOutput("clusterName");
        return listManagedClusterUserCredentialsOutput({
            resourceGroupName: clusterResourceGroup,
            resourceName: clusterName
        })
            .apply(x => x.kubeconfigs[0].value)
            .apply(x => (Buffer.from(x, 'base64')).toString('utf8'));
    }
    else {
        // AWS: generate kubeconfig from cluster name
        const clusterName = config.infraStack.getOutput("clusterName") as pulumi.Output<string>;
        return generateEksKubeconfig(clusterName);
    }
}

/**
 * Generates a kubeconfig for an existing EKS cluster by fetching its details.
 */
function generateEksKubeconfig(clusterName: pulumi.Output<string>): pulumi.Output<string> {
    // Fetch cluster details using the cluster name
    const cluster = aws.eks.getClusterOutput({ name: clusterName });
    const region = aws.getRegionOutput({});

    return pulumi.all([clusterName, cluster, region]).apply(([name, clusterData, regionData]) => {
        const kubeconfig = {
            apiVersion: "v1",
            kind: "Config",
            clusters: [{
                name: "kubernetes",
                cluster: {
                    server: clusterData.endpoint,
                    "certificate-authority-data": clusterData.certificateAuthorities[0].data,
                },
            }],
            contexts: [{
                name: "aws",
                context: {
                    cluster: "kubernetes",
                    user: "aws",
                },
            }],
            "current-context": "aws",
            users: [{
                name: "aws",
                user: {
                    exec: {
                        apiVersion: "client.authentication.k8s.io/v1beta1",
                        command: "aws",
                        args: [
                            "--region", regionData.id,
                            "eks", "get-token",
                            "--cluster-name", name,
                            "--output", "json",
                        ],
                        env: [{
                            name: "KUBERNETES_EXEC_INFO",
                            value: '{"apiVersion": "client.authentication.k8s.io/v1beta1"}',
                        }],
                    },
                },
            }],
        };
        return JSON.stringify(kubeconfig);
    });
}
