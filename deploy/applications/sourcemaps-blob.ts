import * as pulumi from "@pulumi/pulumi";
import * as storage from "@pulumi/azure-native/storage";
import * as authorization from "@pulumi/azure-native/authorization";

export interface SourceMapsContainerArgs {
    resourceGroup: pulumi.Input<string>;

}

export class SourceMapsContainer extends pulumi.ComponentResource {

    public storageConnectionString: pulumi.Output<string>;
    public containerName: pulumi.Output<string>;
    public accountName: pulumi.Output<string>;
    private static StorageBlobDataContributorRoleId = "/providers/Microsoft.Authorization/roleDefinitions/ba92f5b4-2d11-453d-a403-e96b0029c9fe";

    constructor(name: string,
        args: SourceMapsContainerArgs,
        opts: pulumi.ComponentResourceOptions = {}) {
        super("devrel:sourcemaps-container", name, args, opts);

        var storageAccount = new storage.StorageAccount("devrelmaps", {
            resourceGroupName: args.resourceGroup,
            sku: {
                name: storage.SkuName.Standard_LRS,
            },
            kind: storage.Kind.StorageV2,
        });

        var blobContainer = new storage.BlobContainer("source-maps-container", {
            resourceGroupName: args.resourceGroup,
            accountName: storageAccount.name,
            publicAccess: storage.PublicAccess.None,
        });


        var clientConfig = authorization.getClientConfigOutput();
        // add role assigment for current azure principal
        var roleAssignment = new authorization.RoleAssignment("source-maps-role-assignment", {
            principalId: clientConfig.objectId,
            roleDefinitionId: SourceMapsContainer.StorageBlobDataContributorRoleId,
            scope: storageAccount.id
        });

        this.containerName = blobContainer.name;
        this.accountName = storageAccount.name;
        this.storageConnectionString = storage.listStorageAccountKeysOutput({
            resourceGroupName: args.resourceGroup,
            accountName: storageAccount.name
        }).apply(keys => {
            return `DefaultEndpointsProtocol=https;AccountName=${storageAccount.name};AccountKey=${keys.keys[0].value};EndpointSuffix=core.windows.net`;
        });

    }
}
