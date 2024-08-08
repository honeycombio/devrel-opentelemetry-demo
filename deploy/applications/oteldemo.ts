import * as pulumi from "@pulumi/pulumi";
import { Release } from "@pulumi/kubernetes/helm/v3";
import { Ingress } from "@pulumi/kubernetes/networking/v1/ingress";

export interface OtelDemoArgs {
    domainName: pulumi.Input<string>;
    namespace: pulumi.Input<string>;
    collectorHostName: pulumi.Output<string>;
    demoVersion: pulumi.Input<string>;
    ingressClassName: pulumi.Input<string>;
}

export class OtelDemo extends pulumi.ComponentResource {

    public readonly domainName: pulumi.Output<string>;

    constructor(name: string,
        args: OtelDemoArgs,
        opts: pulumi.ComponentResourceOptions = {}) {
        super("devrel:otel-demo", name, args, opts);

        let values = args.collectorHostName.apply(collectorHostName => {
            {
                return {
                    "default": {
                        "replicas": 1,
                        "blah": collectorHostName,
                        "envOverrides": [
                            {
                                "name": "OTEL_COLLECTOR_NAME",
                                "value": collectorHostName
                            }
                        ]
                    }
                };
            }
        })

        values.apply(console.log);

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
                                    name: "otel-demo-frontendproxy",
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

        this.domainName = pulumi.output(`www.${args.domainName}`);
    }
}