import * as pulumi from "@pulumi/pulumi";
import * as kubernetes from "@pulumi/kubernetes";
import { Secret } from "@pulumi/kubernetes/core/v1/secret";
import { Collector } from "./applications/collector";
import { OtelDemo } from "./applications/oteldemo";
import { listManagedClusterUserCredentialsOutput } from "@pulumi/azure-native/containerservice";

const config = new pulumi.Config();
const apiKey = config.require("honeycombApiKey");
const ingressClassName = config.require("ingressClassName");
const infrastack = new pulumi.StackReference("honeycomb-devrel/infra-azure/prod");

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


var podTelemetryCollector = new Collector("pod-telemetry-collector", {
    collectorHelmVersion: "0.97.1",
    namespace: demoNamespace.metadata.name,
    honeycombSecret: secretApiKey,
    valuesFile: "./config-files/collector/values-daemonset.yaml"
}, { provider: provider });



var clusterTelemetryCollector = new Collector("cluster-telemetry-collector", {
    collectorHelmVersion: "0.97.1",
    namespace: demoNamespace.metadata.name,
    honeycombSecret: secretApiKey,
    valuesFile: "./config-files/collector/values-deployment.yaml"
}, { provider: provider });



var demo = new OtelDemo("otel-demo", {
    domainName: "demo.onlyspans.com",
    namespace: demoNamespace.metadata.name,
    collectorHostName: podTelemetryCollector.collectorName,
    demoVersion: "0.32.0",
    ingressClassName: ingressClassName
}, { provider: provider });

// Export some values for use elsewhere

export const clusterResourceGroup = demoClusterResourceGroup;
export const clusterName = demoClusterName;
export const demoUrl = demo.domainName;
