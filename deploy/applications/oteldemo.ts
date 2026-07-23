import * as pulumi from "@pulumi/pulumi";
import * as fs from "fs";
import { Release } from "@pulumi/kubernetes/helm/v3";
import { Ingress } from "@pulumi/kubernetes/networking/v1/ingress";
import { ConfigMap } from "@pulumi/kubernetes/core/v1";
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

        // The otel-demo chart creates a flagd-config ConfigMap from its own bundled flags (no values override).
        // We manage our own ConfigMap with the full superset of flags and rebind the chart's `config-ro`
        // volume to it in values.yaml — flagd and the flagd-ui sidecar both mount config-ro, so the UI can
        // see and toggle every flag. The chart's default flagd-config ConfigMap is still rendered but unused.
        // The Helm release depends on this ConfigMap so that flagd never starts without it mounted.
        const flagdConfigJson = fs.readFileSync("../src/flagd/demo.flagd.json", "utf-8");
        const flagdCustomConfig = new ConfigMap(`${name}-flagd-custom-config`, {
            metadata: {
                name: "flagd-custom-config",
                namespace: args.config.k8sNamespace,
            },
            data: {
                "demo.flagd.json": flagdConfigJson,
            },
        }, { provider: opts.provider! });

        const demoRelease = new Release(`${name}-demo-release`, {
            chart: "opentelemetry-demo",
            name: name,
            version: args.config.versions.demoHelmVersion,
            repositoryOpts: {
                repo: "https://open-telemetry.github.io/opentelemetry-helm-charts"
            },
            dependencyUpdate: true,
            namespace: args.config.k8sNamespace,
            // Previous 900s was exceeded (954s) on the 2.5.0-release deploy
            // when accounting was OOM-looping; failure left state corrupted.
            timeout: 1800,
            values: values,
            valueYamlFiles: [new pulumi.asset.FileAsset("./config-files/demo/values.yaml")]
        }, { provider: opts.provider!, dependsOn: [flagdCustomConfig] });

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