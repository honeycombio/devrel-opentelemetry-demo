import * as pulumi from "@pulumi/pulumi";

/**
 * Strongly-typed configuration class for the deployment.
 * Wraps Pulumi's Config to provide type-safe access to all configuration values.
 */
export class DeploymentConfig {
    private readonly config: pulumi.Config;

    public readonly htpBuilderConfig: HtpBuilderConfig = new HtpBuilderConfig();
    public readonly infraStack: pulumi.StackReference;
    public readonly versions: DeploymentVersions = new DeploymentVersions();

    // Required configuration values
    public readonly honeycombProdApiKey: string;
    public readonly honeycombDogfoodApiKey: string;
    public readonly cloudProvider: string;
    public readonly domainName: string;
    public readonly k8sNamespace: string;

    // Optional configuration values with defaults
    public readonly containerTag: string;
    public readonly collectorContainerTag: string;
    public readonly collectorContainerRepository: string;

    // Azure-specific configuration (optional, required only for Azure deployments)
    public readonly collectorS3AccessKey?: string;
    public readonly collectorS3SecretKey?: string;

    constructor() {
        this.config = new pulumi.Config();
        this.cloudProvider = this.config.require("cloud-provider");
        this.infraStack = new pulumi.StackReference(`honeycomb-devrel/infra-${this.cloudProvider}/prod`);

        // Required values
        this.honeycombProdApiKey = this.config.require("honeycomb-prod-api-key");
        this.honeycombDogfoodApiKey = this.config.require("honeycomb-dogfood-api-key");
        this.domainName = this.config.require("domain-name");

        // Optional values with defaults
        this.containerTag = this.config.get("container-tag") || "latest";
        this.collectorContainerTag = this.config.get("collector-container-tag") || `${this.containerTag}-collector`;
        this.collectorContainerRepository = this.config.get("collector-container-repository") || "ghcr.io/open-telemetry/opentelemetry-collector-releases/opentelemetry-collector-contrib";
        this.k8sNamespace = this.config.get("k8s-namespace") || "devrel-demo";
    }

    /**
     * Check if running on Azure
     */
    get isAzure(): boolean {
        return this.cloudProvider === "azure";
    }

    /**
     * Check if running on AWS
     */
    get isAws(): boolean {
        return this.cloudProvider === "aws";
    }

    get isInPipeline(): boolean {
        return process.env.IS_IN_PIPELINE?.toLowerCase() == "true" || false;
    }

}

export class HtpBuilderConfig {
    private readonly config: pulumi.Config;

    public readonly pipelineId: string | undefined;
    public readonly managementApiKeyId: string | undefined;
    public readonly managementApiKeySecret: pulumi.Output<string> = pulumi.output("");
    public readonly pipelineTelemetryKey: pulumi.Output<string> = pulumi.output("");

    get isEnabled(): boolean {
        return this.pipelineId != "" || false;
    }

    constructor() {
        this.config = new pulumi.Config();

        this.pipelineId = this.config.get("pipeline-id");

        if (!this.isEnabled) {
            return;
        }

        this.managementApiKeyId = this.config.require("pipeline-management-key-id");
        this.managementApiKeySecret = this.config.requireSecret("pipeline-management-key-secret") || "";
        this.pipelineTelemetryKey = this.config.requireSecret("pipeline-telemetry-ingest-key") || "";
    }
}

export class DeploymentVersions {
    public readonly collectorHelmVersion: string;
    public readonly demoHelmVersion: string;
    public readonly refineryHelmVersion: string;
    public readonly defaultCollectorVersion: string;
    public readonly htpBuilderHelmVersion: string;

    constructor() {
        this.collectorHelmVersion = "0.134.0";
        this.defaultCollectorVersion = "0.135.0";
        this.demoHelmVersion = "0.38.6";
        this.refineryHelmVersion = "2.17.0";
        this.htpBuilderHelmVersion = "0.2.0";
    }
}