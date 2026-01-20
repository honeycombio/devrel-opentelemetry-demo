import * as kubernetes from "@pulumi/kubernetes";
import { Collector } from "./applications/collector";
import { OtelDemo } from "./applications/oteldemo";
import { HtpBuilder } from "./applications/htp-builder";
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

// Deploy HTP Builder first if enabled (collectors depend on it)
var htpBuilder: HtpBuilder | undefined;
if (deployConfig.htpBuilderConfig.isEnabled) {
    htpBuilder = new HtpBuilder("htp-builder", {
        config: deployConfig,
        namespace: demoNamespace.metadata.name
    }, { provider: provider });
}

var podTelemetryCollector = new Collector("pod-telemetry-collector", {
    config: deployConfig,
    namespace: demoNamespace.metadata.name,
    secrets: honeycombSecrets,
    valuesFile: "./config-files/collector/values-daemonset.yaml",
    useCustomCollector: true,
    htpReleaseName: htpBuilder?.releaseName
}, { provider: provider, dependsOn: htpBuilder ? [htpBuilder] : [] });

var clusterTelemetryCollector = new Collector("cluster-telemetry-collector", {
    config: deployConfig,
    namespace: demoNamespace.metadata.name,
    secrets: honeycombSecrets,
    valuesFile: "./config-files/collector/values-deployment.yaml",
    useCustomCollector: false,
    htpReleaseName: htpBuilder?.releaseName
}, { provider: provider, dependsOn: htpBuilder ? [htpBuilder] : [] });

var demo = new OtelDemo("otel-demo", {
    config: deployConfig,
    namespace: demoNamespace.metadata.name,
    collectorHostName: podTelemetryCollector.collectorName,
}, { provider: provider });

// Export some values for use elsewhere
export const demoUrl = demo.domainName;
