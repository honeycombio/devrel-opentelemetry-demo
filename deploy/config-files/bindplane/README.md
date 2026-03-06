# BindPlane Setup

BindPlane node agents run as a DaemonSet in the `bindplane-agent` namespace. They receive traces and logs from the daemonset collector and forward them through BindPlane SaaS for processing (e.g., email redaction).

## Components

- `bindplane-agent.yaml` — DaemonSet, ServiceAccount, Services, RBAC. Applied with `kubectl apply -f`, NOT managed by Pulumi.
- `.be` — OpAMP secret key (gitignored)

## S3 Export

Bucket: `aurelia-bindplane-telemetry` (eu-west-1)

### AWS Permissions (TECH DEBT - done via CLI, not Pulumi)

These changes were made manually on 2026-03-06 and need to be moved into the infra Pulumi stack:

1. **IAM policy `s3-access-policy-d4c609d` v2** — added `aurelia-bindplane-telemetry` bucket to the resource list. The infra Pulumi stack still has v1; next `pulumi up` of the infra stack will revert this unless updated.

2. **Pod Identity Association `a-c9jrupiwpskgs4q6e`** — associates `bindplane-agent` service account in `bindplane-agent` namespace with `s3-access-role-05ec9b2`. Not in any Pulumi stack.

Both should be incorporated into the infra Pulumi stack to avoid drift.
