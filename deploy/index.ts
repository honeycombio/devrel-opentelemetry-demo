import * as kubernetes from "@pulumi/kubernetes";
import { Collector } from "./applications/collector";
import { OtelDemo } from "./applications/oteldemo";
import { Refinery } from "./applications/refinery";
import { OtelServices } from "./applications/otel-services";
import { PodIdentityAssociation } from "./applications/pod-identity-association";
import { BedrockPodIdentityAssociation } from "./applications/bedrock-pia";
import { DeploymentConfig } from "./config";
import { HoneycombSecrets } from "./applications/secrets";
import { getKubeconfig } from "./kubeconfig";

// Load strongly-typed configuration
const deployConfig = new DeploymentConfig();

const provider = new kubernetes.Provider("k8s-provider", {
    kubeconfig: getKubeconfig(deployConfig),
    enableServerSideApply: true
});

// Create a namespace (user supplies the name of the namespace)
const demoNamespace = new kubernetes.core.v1.Namespace("demo-namespace", {
    metadata: {
        name: deployConfig.k8sNamespace,
    }
    
}, { provider: provider });

const honeycombSecrets = new HoneycombSecrets("honeycomb", {
    namespace: demoNamespace.metadata.name,
    config: deployConfig
}, { provider: provider });

// Deploy Refinery first (collectors depend on it)
const refinery = new Refinery("refinery", {
    refineryHelmVersion: deployConfig.versions.refineryHelmVersion,
    namespace: demoNamespace.metadata.name,
    telemetryApiKey: deployConfig.honeycombProdApiKey
}, { provider: provider });

var podTelemetryCollector = new Collector("pod-telemetry-collector", {
    config: deployConfig,
    namespace: demoNamespace.metadata.name,
    secrets: honeycombSecrets,
    valuesFile: "./config-files/collector/values-daemonset.yaml",
    useCustomCollector: true,
    refineryHostname: refinery.refineryHostname
}, { provider: provider, dependsOn: [refinery] });

var clusterTelemetryCollector = new Collector("cluster-telemetry-collector", {
    config: deployConfig,
    namespace: demoNamespace.metadata.name,
    secrets: honeycombSecrets,
    valuesFile: "./config-files/collector/values-deployment.yaml",
    useCustomCollector: false,
    refineryHostname: refinery.refineryHostname
}, { provider: provider, dependsOn: [refinery] });

var demo = new OtelDemo("otel-demo", {
    config: deployConfig,
    namespace: demoNamespace.metadata.name,
    collectorHostName: podTelemetryCollector.collectorName,
}, { provider: provider });

// Create pod identity associations for AWS deployments to allow S3 access
if (deployConfig.isAws) {
    // Associate S3 role with the pod-telemetry-collector service account
    new PodIdentityAssociation("pod-collector-s3", {
        config: deployConfig,
        namespace: demoNamespace.metadata.name,
        serviceAccountName: "pod-telemetry-collector-opentelemetry-collector"
    }, { dependsOn: [podTelemetryCollector] });

    // Associate S3 role with the cluster-telemetry-collector service account
    new PodIdentityAssociation("cluster-collector-s3", {
        config: deployConfig,
        namespace: demoNamespace.metadata.name,
        serviceAccountName: "cluster-telemetry-collector-opentelemetry-collector"
    }, { dependsOn: [clusterTelemetryCollector] });

    // Associate Bedrock role with the demo service accounts when Bedrock is enabled.
    // `otel-services` runs storechat/llm-evals (our chart); `otel-demo` runs
    // product-reviews (the upstream chart) — both need Bedrock when we point
    // product-reviews at `LLM_PROVIDER=bedrock`.
    if (deployConfig.enableBedrock) {
        new BedrockPodIdentityAssociation("demo-bedrock", {
            config: deployConfig,
            namespace: demoNamespace.metadata.name,
            serviceAccountName: "otel-services",
        }, { dependsOn: [demo] });
        new BedrockPodIdentityAssociation("demo-bedrock-otel-demo", {
            config: deployConfig,
            namespace: demoNamespace.metadata.name,
            serviceAccountName: "otel-demo",
        }, { dependsOn: [demo] });
    }
}

// Deploy storechat and llm-evals when Bedrock is enabled
if (deployConfig.enableBedrock) {
    new OtelServices("otel-services", {
        config: deployConfig,
        namespace: demoNamespace.metadata.name,
        collectorName: podTelemetryCollector.collectorName,
    }, { provider: provider, dependsOn: [demo] });
}

// Export some values for use elsewhere
export const demoUrl = demo.domainName;
