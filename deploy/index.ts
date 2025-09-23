import * as pulumi from "@pulumi/pulumi";
import * as kubernetes from "@pulumi/kubernetes";
import { Secret } from "@pulumi/kubernetes/core/v1/secret";
import { Collector } from "./applications/collector";
import { OtelDemo } from "./applications/oteldemo";
import { TelemetryPipeline } from "./applications/telemetry-pipeline";
import { listManagedClusterUserCredentialsOutput } from "@pulumi/azure-native/containerservice";
import { Refinery } from "./applications/refinery";
import * as storage from "@pulumi/azure-native/storage";

const collectorHelmVersion = "0.134.0";
const demoHelmVersion = "0.37.0";
const refineryHelmVersion = "2.17.0";

const config = new pulumi.Config();
const apiKey = config.require("honeycombApiKey");
const dogfoodApiKey = config.require("honeycombApiKeyDogfood");
const ingressClassName = config.require("ingressClassName");
const infrastack = new pulumi.StackReference("honeycomb-devrel/infra-azure/prod");
const containerTag = config.get("container-tag") || "latest";
const pipelineManagementApiKey = config.require("pipelineManagementApiKey");
const pipelineManagementApiKeyId = config.require("pipelineManagementApiKeyId");
const pipelineApiKey = config.require("pipelineApiKey");
const refineryTelemetryApiKey = config.require("refineryTelemetryApiKey");
const collectorS3AccessKey = config.require("collectorS3AccessKey");
const collectorS3SecretKey = config.require("collectorS3SecretKey");
const collectorContainerTag = config.get("collector-container-tag") || `${containerTag}-collector`;
const collectorContainerRepository = config.get("collector-container-repository") || "ghcr.io/open-telemetry/opentelemetry-collector-releases/opentelemetry-collector-contrib";

const demoClusterResourceGroup = infrastack.getOutput("clusterResourceGroup");
const demoClusterName = infrastack.getOutput("clusterName");


const kubeconfig = listManagedClusterUserCredentialsOutput({
    resourceGroupName: demoClusterResourceGroup,
    resourceName: demoClusterName
})
    .apply(x => x.kubeconfigs[0].value)
    .apply(x => (Buffer.from(x, 'base64')).toString('utf8'))

const provider = new kubernetes.Provider("aks-provider", {
    kubeconfig: kubeconfig,
    enableServerSideApply: true
});

// Create a namespace (user supplies the name of the namespace)
const demoNamespace = new kubernetes.core.v1.Namespace("demo-namespace", {
    metadata: {
        name: "devrel-demo",
    }
    
}, { provider: provider });

const secretApiKey = new Secret("honey", {
    metadata: {
        name: "honeycomb-api",
        namespace: demoNamespace.metadata.name
    },
    stringData: {
        ["honeycomb-api-key"]: apiKey
    }
}, { provider: provider })

const secretDogfoodApiKey = new Secret("honey-dogfood", {
    metadata: {
        name: "honeycomb-api-dogfood",
        namespace: demoNamespace.metadata.name
    },
    stringData: {
        ["honeycomb-api-key"]: dogfoodApiKey
    }
}, { provider: provider })

var storageAccount = new storage.StorageAccount("devrelmaps", {
    resourceGroupName: demoClusterResourceGroup,
    sku: {
        name: storage.SkuName.Standard_LRS,
    },
    kind: storage.Kind.StorageV2,
});

var blobContainer = new storage.BlobContainer("source-maps-container", {
    resourceGroupName: demoClusterResourceGroup,
    accountName: storageAccount.name,
    publicAccess: storage.PublicAccess.None,
});

var storageConnectionString = storage.listStorageAccountKeysOutput({
    resourceGroupName: demoClusterResourceGroup,
    accountName: storageAccount.name
}).apply(keys => {
    return `DefaultEndpointsProtocol=https;AccountName=${storageAccount.name};AccountKey=${keys.keys[0].value};EndpointSuffix=core.windows.net`;
});

var telemetryPipeline = new TelemetryPipeline("telemetry-pipeline", {
    namespace: demoNamespace.metadata.name,
    pipelineHoneycombApiKey: pipelineApiKey,
    pipelineHoneycombManagementApiKey: pipelineManagementApiKey,
    pipelineHoneycombManagementApiKeyId: pipelineManagementApiKeyId,
    useDogfood: true,
    s3AccessKey: collectorS3AccessKey,
    s3SecretKey: collectorS3SecretKey
}, { provider: provider });

var refinery = new Refinery("refinery", {
    refineryHelmVersion: refineryHelmVersion,
    namespace: demoNamespace.metadata.name,
    telemetryApiKey: refineryTelemetryApiKey
}, { provider: provider });

var podTelemetryCollector = new Collector("pod-telemetry-collector", {
    collectorHelmVersion: collectorHelmVersion,
    namespace: demoNamespace.metadata.name,
    honeycombSecret: secretApiKey,
    honeycombDogfoodSecret: secretDogfoodApiKey,
    valuesFile: "./config-files/collector/values-daemonset.yaml",
    refineryHostname: refinery.refineryHostname,
    telemetryPipelineReleaseName: telemetryPipeline.releaseName,
    collectorContainerTag: collectorContainerTag,
    collectorContainerRepository: collectorContainerRepository,
    sourceMapsStorageConnectionString: storageConnectionString,
    sourceMapsContainerName: blobContainer.name
}, { provider: provider });

var clusterTelemetryCollector = new Collector("cluster-telemetry-collector", {
    collectorHelmVersion: collectorHelmVersion,
    namespace: demoNamespace.metadata.name,
    honeycombSecret: secretApiKey,
    honeycombDogfoodSecret: secretDogfoodApiKey,
    valuesFile: "./config-files/collector/values-deployment.yaml",
    telemetryPipelineReleaseName: telemetryPipeline.releaseName
}, { provider: provider });



var demo = new OtelDemo("otel-demo", {
    domainName: "zurelia.honeydemo.io",
    namespace: demoNamespace.metadata.name,
    collectorHostName: podTelemetryCollector.collectorName,
    demoVersion: demoHelmVersion,
    containerTag: containerTag,
    ingressClassName: ingressClassName
}, { provider: provider });

// Export some values for use elsewhere

export const clusterResourceGroup = demoClusterResourceGroup;
export const clusterName = demoClusterName;
export const demoUrl = demo.domainName;
export const telemetryPipelineReleaseName = telemetryPipeline.releaseName;
