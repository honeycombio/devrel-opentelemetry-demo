import * as pulumi from "@pulumi/pulumi";
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
        // get kubeconfig straight from the infra stack
        return config.infraStack.getOutput("kubeconfig") as pulumi.Output<string>;
    }
}
