import * as kubernetes from "@pulumi/kubernetes";
import { Collector } from "./applications/collector";
import { OtelDemo } from "./applications/oteldemo";
import { HtpBuilder } from "./applications/htp-builder";
import { PodIdentityAssociation } from "./applications/pod-identity-association";
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

// Deploy HTP Builder first (collectors depend on it)
const htpBuilder = new HtpBuilder("htp-builder", {
    config: deployConfig,
    namespace: demoNamespace.metadata.name
}, { provider: provider });

var podTelemetryCollector = new Collector("pod-telemetry-collector", {
    config: deployConfig,
    namespace: demoNamespace.metadata.name,
    secrets: honeycombSecrets,
    valuesFile: "./config-files/collector/values-daemonset.yaml",
    useCustomCollector: true,
    htpReleaseName: htpBuilder.releaseName
}, { provider: provider, dependsOn: [htpBuilder] });

var clusterTelemetryCollector = new Collector("cluster-telemetry-collector", {
    config: deployConfig,
    namespace: demoNamespace.metadata.name,
    secrets: honeycombSecrets,
    valuesFile: "./config-files/collector/values-deployment.yaml",
    useCustomCollector: false,
    htpReleaseName: htpBuilder.releaseName
}, { provider: provider, dependsOn: [htpBuilder] });

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

    // Associate S3 role with the htp-builder primary collector service account
    new PodIdentityAssociation("htp-collector-s3", {
        config: deployConfig,
        namespace: demoNamespace.metadata.name,
        serviceAccountName: "htp-builder-htp-builder-primary-collector"
    }, { dependsOn: [htpBuilder] });
}

// Export some values for use elsewhere
export const demoUrl = demo.domainName;
