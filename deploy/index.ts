import * as pulumi from "@pulumi/pulumi";
import * as kubernetes from "@pulumi/kubernetes";
import { Secret } from "@pulumi/kubernetes/core/v1/secret";
import { Collector } from "./applications/collector";
import { OtelDemo } from "./applications/oteldemo";
import { TelemetryPipeline } from "./applications/telemetry-pipeline";
import { listManagedClusterUserCredentialsOutput } from "@pulumi/azure-native/containerservice";
import { Refinery } from "./applications/refinery";

const collectorHelmVersion = "0.107.0";
const demoHelmVersion = "0.37.0";

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


var telemetryPipeline = new TelemetryPipeline("telemetry-pipeline", {
    namespace: demoNamespace.metadata.name,
    pipelineHoneycombApiKey: pipelineApiKey,
    pipelineHoneycombManagementApiKey: pipelineManagementApiKey,
    pipelineHoneycombManagementApiKeyId: pipelineManagementApiKeyId,
    useDogfood: true
}, { provider: provider });

var refinery = new Refinery("refinery", {
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
    telemetryPipelineReleaseName: telemetryPipeline.releaseName
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
