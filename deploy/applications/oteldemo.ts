import * as pulumi from "@pulumi/pulumi";
import { Release } from "@pulumi/kubernetes/helm/v3";
import { Ingress } from "@pulumi/kubernetes/networking/v1/ingress";
import { Deployment } from "@pulumi/kubernetes/apps/v1";
import { Service } from "@pulumi/kubernetes/core/v1";
import { CustomResource } from "@pulumi/kubernetes/apiextensions";
import { DeploymentConfig } from "../config";

export interface OtelDemoArgs {
    config: DeploymentConfig;
    collectorHostName: pulumi.Output<string>;
    namespace: pulumi.Output<string>;
}

export class OtelDemo extends pulumi.ComponentResource {

    public readonly domainName: pulumi.Output<string>;

    constructor(name: string,
        args: OtelDemoArgs,
        opts: pulumi.ComponentResourceOptions = {}) {
        super("devrel:otel-demo", name, args, opts);

        const values =
        {
            "default": {
                "envOverrides": [
                    {
                        "name": "OTEL_COLLECTOR_NAME",
                        "value": args.collectorHostName
                    }
                ],
                "image": {
                    "tag": args.config.containerTag
                }
            }
        };

        const demoRelease = new Release(`${name}-demo-release`, {
            chart: "opentelemetry-demo",
            name: name,
            version: args.config.versions.demoHelmVersion,
            repositoryOpts: {
                repo: "https://open-telemetry.github.io/opentelemetry-helm-charts"
            },
            dependencyUpdate: true,
            namespace: args.config.k8sNamespace,
            values: values,
            valueYamlFiles: [new pulumi.asset.FileAsset("./config-files/demo/values.yaml")]
        }, { provider: opts.provider! });

        // These services and deployments can be removed when the new helm chart is released
        const productReviewsService = new Service(`${name}-product-reviews-service`, {
            metadata: {
                namespace: args.namespace,
                labels: {
                    "opentelemetry.io/name": "product-reviews",
                    "app.kubernetes.io/component": "product-reviews",
                    "app.kubernetes.io/name": "product-reviews",
                    "app.kubernetes.io/part-of": "opentelemetry-demo"
                },
                name: "product-reviews"
            },
            spec: {
                type: "ClusterIP",
                ports: [{
                    port: 3551,
                    name: "tcp-service",
                    targetPort: 3551,
                    protocol: "TCP"
                }],
                selector: {
                    "opentelemetry.io/name": "product-reviews"
                }
            }
        }, { provider: opts.provider! });

        // Product Reviews Deployment
        const productReviewsDeployment = new Deployment(`${name}-product-reviews`, {
            metadata: {
                namespace: args.namespace,
                labels: {
                    "opentelemetry.io/name": "product-reviews",
                    "app.kubernetes.io/component": "product-reviews",
                    "app.kubernetes.io/name": "product-reviews",
                    "app.kubernetes.io/part-of": "opentelemetry-demo"
                },
                name: "product-reviews"
            },
            spec: {
                replicas: 1,
                revisionHistoryLimit: 10,
                selector: {
                    matchLabels: {
                        "opentelemetry.io/name": "product-reviews"
                    }
                },
                template: {
                    metadata: {
                        labels: {
                            "opentelemetry.io/name": "product-reviews",
                            "app.kubernetes.io/component": "product-reviews",
                            "app.kubernetes.io/name": "product-reviews"
                        }
                    },
                    spec: {
                        serviceAccountName: "otel-demo",
                        containers: [{
                            name: "product-reviews",
                            image: `ghcr.io/honeycombio/devrel-opentelemetry-demo:${args.config.containerTag}-product-reviews`,
                            imagePullPolicy: "IfNotPresent",
                            ports: [{
                                containerPort: 3551,
                                name: "service"
                            }],
                            env: [
                                {
                                    name: "OTEL_SERVICE_NAME",
                                    valueFrom: {
                                        fieldRef: {
                                            apiVersion: "v1",
                                            fieldPath: "metadata.labels['app.kubernetes.io/component']"
                                        }
                                    }
                                },
                                { name: "OTEL_COLLECTOR_NAME", value: args.collectorHostName },
                                { name: "OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE", value: "delta" },
                                { name: "PRODUCT_REVIEWS_PORT", value: "3551" },
                                { name: "OTEL_PYTHON_LOG_CORRELATION", value: "true" },
                                { name: "OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT", value: "true" },
                                { name: "PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION", value: "python" },
                                { name: "DB_CONNECTION_STRING", value: "host=postgresql user=otelu password=otelp dbname=otel" },
                                { name: "LLM_BASE_URL", value: "http://llm:8000/v1" },
                                { name: "OPENAI_API_KEY", value: "dummy" },
                                { name: "LLM_MODEL", value: "astronomy-llm" },
                                { name: "PRODUCT_CATALOG_ADDR", value: "product-catalog:3550" },
                                { name: "FLAGD_HOST", value: "flagd" },
                                { name: "FLAGD_PORT", value: "8013" },
                                { name: "LLM_HOST", value: "llm" },
                                { name: "LLM_PORT", value: "8000" },
                                { name: "OTEL_EXPORTER_OTLP_ENDPOINT", value: `http://$(OTEL_COLLECTOR_NAME):4317` }
                            ]
                        }]
                    }
                }
            }
        }, { provider: opts.provider!, dependsOn: [demoRelease] });

        // LLM Service
        const llmService = new Service(`${name}-llm-service`, {
            metadata: {
                namespace: args.namespace,
                labels: {
                    "opentelemetry.io/name": "llm",
                    "app.kubernetes.io/component": "llm",
                    "app.kubernetes.io/name": "llm",
                    "app.kubernetes.io/part-of": "opentelemetry-demo"
                },
                name: "llm"
            },
            spec: {
                type: "ClusterIP",
                ports: [{
                    port: 8000,
                    name: "tcp-service",
                    targetPort: 8000,
                    protocol: "TCP"
                }],
                selector: {
                    "opentelemetry.io/name": "llm"
                }
            }
        }, { provider: opts.provider! });

        // LLM Deployment
        const llmDeployment = new Deployment(`${name}-llm`, {
            metadata: {
                namespace: args.namespace,
                labels: {
                    "opentelemetry.io/name": "llm",
                    "app.kubernetes.io/component": "llm",
                    "app.kubernetes.io/name": "llm",
                    "app.kubernetes.io/part-of": "opentelemetry-demo"
                },
                name: "llm"
            },
            spec: {
                replicas: 1,
                revisionHistoryLimit: 10,
                selector: {
                    matchLabels: {
                        "opentelemetry.io/name": "llm"
                    }
                },
                template: {
                    metadata: {
                        labels: {
                            "opentelemetry.io/name": "llm",
                            "app.kubernetes.io/component": "llm",
                            "app.kubernetes.io/name": "llm"
                        }
                    },
                    spec: {
                        serviceAccountName: "otel-demo",
                        containers: [{
                            name: "llm",
                            image: `ghcr.io/honeycombio/devrel-opentelemetry-demo:${args.config.containerTag}-llm`,
                            imagePullPolicy: "IfNotPresent",
                            ports: [{
                                containerPort: 8000,
                                name: "service"
                            }],
                            env: [
                                {
                                    name: "OTEL_SERVICE_NAME",
                                    valueFrom: {
                                        fieldRef: {
                                            apiVersion: "v1",
                                            fieldPath: "metadata.labels['app.kubernetes.io/component']"
                                        }
                                    }
                                },
                                { name: "OTEL_COLLECTOR_NAME", value: args.collectorHostName },
                                { name: "OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE", value: "delta" },
                                { name: "FLAGD_HOST", value: "flagd" },
                                { name: "FLAGD_PORT", value: "8013" },
                                { name: "OTEL_EXPORTER_OTLP_ENDPOINT", value: `http://$(OTEL_COLLECTOR_NAME):4317` }
                            ]
                        }]
                    }
                }
            }
        }, { provider: opts.provider!, dependsOn: [demoRelease] });

        if (args.config.isAzure) {
            var certificate = new CustomResource(`${name}-certificate`, {
                apiVersion: "cert-manager.io/v1",
                kind: "Certificate",
                metadata: {
                    namespace: args.namespace,
                },
                spec: {
                    secretName: `www-${args.config.domainName}-tls`,
                    issuerRef: {
                        name: `letsencrypt-prod-${args.config.domainName}`,
                        kind: "ClusterIssuer"
                    },
                    commonName: `www.${args.config.domainName}`,
                    dnsNames: [`www.${args.config.domainName}`],
                    privateKey: {
                        rotationPolicy: "Always"
                    },
                    usages: [
                        "server auth",
                        "digital signature",
                        "key encipherment"
                    ]
                }
            }, { provider: opts.provider! });

            var ingress = new Ingress(`${name}-frontend-ingress`, {
                metadata: {
                    namespace: args.namespace,
                },
                spec: {
                    ingressClassName: "webapprouting.kubernetes.azure.com",
                    rules: [{
                        host: `www.${args.config.domainName}`,
                        http: {
                            paths: [{
                                path: "/",
                                pathType: "Prefix",
                                backend: {
                                    service: {
                                        name: "frontend-proxy",
                                        port: {
                                            number: 8080
                                        }
                                    }
                                }
                            }]
                        }
                    }],
                    tls: [{
                        hosts: [`www.${args.config.domainName}`],
                        secretName: `www-${args.config.domainName}-tls`
                    }]
                }
            }, {
                dependsOn: [demoRelease],
                provider: opts?.provider!
            });
        }
        else if (args.config.isAws) {
            var ingress = new Ingress(`${name}-frontend-ingress`, {
                metadata: {
                    namespace: args.namespace,
                    annotations: {
                        "alb.ingress.kubernetes.io/scheme": "internet-facing",
                        "alb.ingress.kubernetes.io/target-type": "ip",
                        "alb.ingress.kubernetes.io/listen-ports": '[{"HTTP": 80, "HTTPS": 443}]',
                        "alb.ingress.kubernetes.io/backend-protocol": "HTTP",
                    }
                },
                spec: {
                    ingressClassName: "alb",
                    rules: [{
                        host: `www.${args.config.domainName}`,
                        http: {
                            paths: [{
                                path: "/",
                                pathType: "Prefix",
                                backend: {
                                    service: {
                                        name: "frontend-proxy",
                                        port: {
                                            number: 8080
                                        }
                                    }
                                }
                            }]
                        }
                    }]
                }
            }, {
                dependsOn: [demoRelease],
                provider: opts?.provider!
            });
        }

        this.domainName = pulumi.output(`www.${args.config.domainName}`);
    }
}