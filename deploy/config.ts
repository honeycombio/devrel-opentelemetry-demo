import * as pulumi from "@pulumi/pulumi";

/**
 * Strongly-typed configuration class for the deployment.
 * Wraps Pulumi's Config to provide type-safe access to all configuration values.
 */
export class DeploymentConfig {
    private readonly config: pulumi.Config;

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

    // Optional Bedrock enablement (AWS only)
    public readonly enableBedrock: boolean;

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
        this.enableBedrock = this.config.getBoolean("enable-bedrock") ?? false;
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

export class DeploymentVersions {
    public readonly collectorHelmVersion: string;
    public readonly demoHelmVersion: string;
    public readonly refineryHelmVersion: string;
    public readonly defaultCollectorVersion: string;
    constructor() {
        this.collectorHelmVersion = "0.134.0";
        this.defaultCollectorVersion = "0.135.0";
        this.demoHelmVersion = "0.39.0";
        this.refineryHelmVersion = "2.17.0";
    }
}