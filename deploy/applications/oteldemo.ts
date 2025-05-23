import * as pulumi from "@pulumi/pulumi";
import { Release } from "@pulumi/kubernetes/helm/v3";
import { Ingress } from "@pulumi/kubernetes/networking/v1/ingress";
import { CustomResource } from "@pulumi/kubernetes/apiextensions";

export interface OtelDemoArgs {
    domainName: pulumi.Input<string>;
    namespace: pulumi.Input<string>;
    collectorHostName: pulumi.Output<string>;
    demoVersion: pulumi.Input<string>;
    ingressClassName: pulumi.Input<string>;
    containerTag: pulumi.Input<string>;
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
                    "tag": args.containerTag
                }
            }
        };

        const demoRelease = new Release(`${name}-demo-release`, {
            chart: "opentelemetry-demo",
            name: name,
            version: args.demoVersion,
            repositoryOpts: {
                repo: "https://open-telemetry.github.io/opentelemetry-helm-charts"
            },
            dependencyUpdate: true,
            namespace: args.namespace,
            values: values,
            valueYamlFiles: [new pulumi.asset.FileAsset("./config-files/demo/values.yaml")]
        }, { provider: opts.provider! });

        var certificate = new CustomResource(`${name}-certificate`, {
            apiVersion: "cert-manager.io/v1",
            kind: "Certificate",
            metadata: {
                namespace: args.namespace,
            },
            spec: {
                secretName: `www-${args.domainName}-tls`,
                issuerRef: {
                    name: `letsencrypt-prod-${args.domainName}`,
                    kind: "ClusterIssuer"
                },
                commonName: `www.${args.domainName}`,
                dnsNames: [`www.${args.domainName}`],
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
                ingressClassName: args.ingressClassName,
                rules: [{
                    host: `www.${args.domainName}`,
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
                    hosts: [`www.${args.domainName}`],
                    secretName: `www-${args.domainName}-tls`
                }]
            }
        }, {
            dependsOn: [demoRelease],
            provider: opts?.provider!
        });

        this.domainName = pulumi.output(`www.${args.domainName}`);
    }
}