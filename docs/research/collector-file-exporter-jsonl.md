# Research: write local collector telemetry to JSONL files in ./telemetry

Date: 2026-10-01. Scope: the `kenrimple-local` collector (daemonset, Helm chart `opentelemetry-demo` 0.39.0,
config in `skaffold-config/demo-values.yaml`). Throwaway, local only, never merged. No code was changed.

## Short answer

- The `fileexporter` can write JSONL. One exporter instance per file.
- **Blocker 1: the repo's custom collector image does not include `fileexporter`.** Add it to
  `deploy/config-files/custom-collector/ocb-config.yaml` and rebuild (`./run otelcollector ...`).
- **Blocker 2: the collector runs on remote EKS, and its image is distroless (no `tar`, no shell).**
  Plain `kubectl cp` from the collector container fails. Use a helper sidecar that shares the volume.
- **Daemonset spread:** 9+ collector pods, one per node, and the Service uses `internalTrafficPolicy=Local`
  (your finding). Each app talks only to the collector on its own node, so data is split across pods.

## 1. fileexporter config

Source: [fileexporter README v0.151.0](https://raw.githubusercontent.com/open-telemetry/opentelemetry-collector-contrib/v0.151.0/exporter/fileexporter/README.md)
(0.151.0 is the version `ocb-config.yaml` pins).

- Supports traces, metrics, logs. Traces and metrics are alpha. `path` is required.
- `format` default `json` (other: `proto`). Quote: "When `format` is json and `compression` is none,
  telemetry data is written to file in JSON format. Each line in the file is a JSON object."
  So each line is one OTLP-JSON export request (one batch). It is JSONL, but one line per batch, not per span.
- `append` default `false`: the file is truncated on collector start. Use `append: true`.
- `flush_interval` default `1s` (README: ignored if rotation is set).
- `create_directory` default `false`; `directory_permissions` default `0755`.
- `rotation` is optional. If the block is present: `max_megabytes` 100, `max_backups` 100, `max_days` unlimited.
  On rotation "the file will be renamed by putting the current time in a timestamp in the name immediately before
  the file's extension" (`traces.jsonl` becomes `traces-2022-09-14T05-02-14.173.jsonl`).
  **Leave out the `rotation:` block** so no rename happens. (My reading of the README: rotation is opt-in.
  Not confirmed in the source code.)
- README: "if `append: true` is set then setting `rotation` or `compression` is currently not supported."
  So use `append: true` with no rotation and no compression.
- `group_by` (off by default) splits files per resource attribute. Not needed.
- Several instances are normal; the README shows `file/no_rotation` and `file/rotation_with_custom_settings`.
  Use `file/traces`, `file/logs`, `file/metrics`.
- README warns: "There is no guarantee that exact field names will remain stable."

## 2. Getting files from the pod to `./telemetry`

Cluster (read-only checks):
- `skaffold.yaml` deploys to `namespace: "{{.USER}}-local"`.
- `./run` calls `scripts/set-kubecontext.sh aws` which runs `aws eks update-kubeconfig ... --alias devrel-demo-aws`.
  Current context is `devrel-demo-aws` (EKS, eu-west-1). `docker-desktop` and `orbstack` contexts exist, but `./run`
  does not use them. The collector is on a **remote** cluster, so `./telemetry` on the laptop is not reachable by a pod path.

Image:
- `skaffold.yaml` uses your build when `otelcollector` is in the `./run` args. Otherwise it uses
  `ghcr.io/honeycombio/devrel-opentelemetry-demo:latest-collector`.
- `ocb-config.yaml` (v0.151.0) exporters: debug, otlphttp, otlp, opensearch, kafka, honeycombmarker, awss3.
  **No `fileexporter`.** Add under `exporters:`:
  `- gomod: github.com/open-telemetry/opentelemetry-collector-contrib/exporter/fileexporter v0.151.0`
- `Dockerfile` final stage is `gcr.io/distroless/cc`, user 10001:10001. No `tar`, no `sh`. `kubectl cp` needs `tar`
  in the container, so it fails on the collector container.

Options for getting files out:

| Option | Verdict |
|---|---|
| (a) emptyDir + sidecar + `kubectl cp` | Recommended. Sidecar (busybox) has `tar`. |
| (b) hostPath | Writes to the EKS node, not the laptop. Unusable. |
| (c) otelcol-contrib in Docker on the laptop | Cluster apps cannot reach the laptop without a tunnel. Not simple. |
| (d) Existing `awss3` exporter, then `aws s3 sync` | No rebuild. One object per batch, not one file. See Fallback. |

For (a): add an `emptyDir` volume, mount it in the collector at `/telemetry`, add a sidecar via `extraContainers`
that mounts the same volume and runs `sleep infinity`. Copy with
`kubectl cp -c telemetry-reader <pod>:/telemetry ./telemetry/<pod>`.
The chart has `extraVolumes`, `extraVolumeMounts` and `extraContainers` ("List of extra sidecars to add.").
Source: [chart values.yaml](https://raw.githubusercontent.com/open-telemetry/opentelemetry-helm-charts/main/charts/opentelemetry-collector/values.yaml).
Nodes must pull `busybox` (Docker Hub). If that is blocked, use an image from ECR.

Files are snapshots, not live. emptyDir is lost when the pod is deleted, and a `skaffold run` that changes the pod
spec recreates pods. Copy out before redeploying.

### Daemonset spread: two ways to handle it

Why it is split: daemonset mode gives one pod per node. With `internalTrafficPolicy: Local` on the Service,
each app reaches only the collector on its own node. So each pod's file holds only that node's apps. Also
`filelog` reads that node's `/var/log/pods`, so container-log records are per node too.

**Option X: keep daemonset, copy from all pods (simplest, no behaviour change).**
```bash
for p in $(kubectl -n kenrimple-local get pods -l app.kubernetes.io/name=opentelemetry-collector -o name | cut -d/ -f2); do
  mkdir -p telemetry/$p && kubectl -n kenrimple-local cp -c telemetry-reader $p:/telemetry telemetry/$p
done
cat telemetry/*/traces.jsonl > telemetry/traces.jsonl   # repeat for logs, metrics
```
Cost: 9+ sidecars and 9+ copies; each pod also writes its own files on disk. Lines are not time-ordered
across pods. A replay tool must sort by timestamp. Traces from one request can be split across pods
(a trace crosses services on different nodes), which is fine for replay if you merge by trace id.

**Option Y: `mode: deployment`, 1 replica (one pod gets everything).**
Set `mode: deployment`, `replicaCount: 1`, and change the Service to `internalTrafficPolicy: Cluster`
(the chart exposes `service.internalTrafficPolicy`; I did not verify the default or the field in the chart,
so confirm with `helm template`). Result: one file set, one copy command, no sort across pods.
Costs, and this changes more than the export:
- The `logsCollection` preset mounts `/var/log/pods` of the node and reads it with `filelog`. A single pod only sees
  its own node's logs. Pod log records from the other nodes (access-logs, flagd-ui "Flag changed:" lines, accounting/cart
  console logs) would vanish from both Honeycomb and the file. That also breaks `logs/markers`. I did not confirm how
  the chart handles `logsCollection` in deployment mode; check with `helm template`. Treat it as unsupported.
- The same applies to `kubeletMetrics`-style per-node receivers if you enable them.
- OTLP data (traces, OTLP logs, OTLP metrics) is fine. If the replay project only needs app OTLP telemetry,
  this is the cleanest.
- It also makes your local collector differ from the rest of the demo, and a single replica can bottleneck under
  load-gen.

**Option Z: two tiers (daemonset stays, plus one small gateway).** Daemonset pods keep Honeycomb export and add an
`otlp` exporter to a new single-replica gateway that has the file exporters. One file set, logs from all nodes
included, no change to the Honeycomb path. Cost: a second Helm release or chart object (not in the repo), and a new
hop. More work than X or Y. I do not recommend it for a throwaway.

Recommendation: **X** if you need pod logs; **Y** only if you accept losing filelog logs.

## 3. How `demo-values.yaml` is structured

- All config is under top-level `opentelemetry-collector:` (`mode: daemonset`, `service.enabled: true`).
- `config.receivers` (otlp, filelog), `config.processors` (transform/*, filter/*, drain),
  `config.exporters` (`debug/detailed`, `awss3`, `otlp/honeycomb`, `honeycombmarker`, `kafka/llm-evals`),
  `config.service.pipelines`.
- Pipelines: `metrics`, `logs`, `traces`, plus `traces/evals` and `logs/markers`.
  `traces` exporters: `otlp/honeycomb`, `spanmetrics`, `awss3`. `logs`: `otlp/honeycomb`, `awss3`.
  `metrics`: `otlp/honeycomb` only (comment: awss3 panics on empty ResourceMetrics batches from spanmetrics).
- Helm lists replace. Chart README: "lists in helm are not merged, so if you want to modify any default list you must
  specify all items, including any default items you want to keep."
  Source: [chart README](https://raw.githubusercontent.com/open-telemetry/opentelemetry-helm-charts/main/charts/opentelemetry-collector/README.md).
  So each pipeline `exporters:` list must be restated in full. Maps (like `config.exporters`) merge.
- The pipeline `processors` lists in this file are already complete; they have no `batch` or `memory_limiter`.
  If you only override `exporters`, the `processors` from `demo-values.yaml` stay (different key, the overlay does not
  touch it).
- Keep `otlp/honeycomb` (and `spanmetrics` in traces) in each list and Honeycomb is undisturbed.
- Untracked `skaffold-config/s3-export-values.yaml` is a generated overlay from
  `docs/superpowers/plans/2026-07-10-s3-telemetry-export.md` (branch `ken/add-s3-export-for-telemetry-capture`).
  On this branch `skaffold.yaml` does not list it in `valuesFiles`, so it does nothing here. It adds `awss3` to all
  three pipelines and restates `processors` (with `batch`). Same idea, S3 instead of files. Do not copy its metrics entry:
  `demo-values.yaml` says awss3 crashes on metrics.

Snippet. Put it in a new untracked overlay (e.g. `skaffold-config/file-export-values.yaml`) and append it as the last
`valuesFiles` entry locally, or edit `demo-values.yaml` locally without committing:

```yaml
opentelemetry-collector:
  extraVolumes:
    - name: telemetry-out
      emptyDir: {}
  extraVolumeMounts:
    - name: telemetry-out
      mountPath: /telemetry
  extraContainers:
    - name: telemetry-reader
      image: busybox:1.36
      command: ["sleep", "infinity"]
      volumeMounts:
        - name: telemetry-out
          mountPath: /telemetry
  config:
    exporters:
      file/traces:
        path: /telemetry/traces.jsonl
        append: true
        flush_interval: 1s
      file/logs:
        path: /telemetry/logs.jsonl
        append: true
        flush_interval: 1s
      file/metrics:
        path: /telemetry/metrics.jsonl
        append: true
        flush_interval: 1s
    service:
      pipelines:
        traces:
          exporters: [otlp/honeycomb, spanmetrics, file/traces]
        logs:
          exporters: [otlp/honeycomb, file/logs]
        metrics:
          exporters: [otlp/honeycomb, file/metrics]
```

Cautions: last `valuesFiles` entry wins. `extraVolumes`, `extraVolumeMounts`, `extraContainers` are lists; if any other
values file sets them, restate those items. `deploy/config-files/demo/values.yaml` only has
`opentelemetry-collector.enabled: false` and `demo-values.yaml` sets none of these lists. I did not run
`helm template` to confirm the rendered result. Do that first (read-only).

## 4. Permissions, rotation, flush

- The collector runs as UID/GID 10001 (`Dockerfile`). Kubernetes normally creates `emptyDir` world-writable, so the
  non-root user can write (general Kubernetes behaviour, not re-verified here). On "permission denied" set
  `podSecurityContext: {fsGroup: 10001}` (chart default `{}`) or use an init container; the chart values.yaml suggests
  init containers for "initializing filesystem permissions to the OTLP Collector user `10001`".
- No `create_directory` needed: the mount path exists.
- Rotation: omit `rotation:`. File names stay fixed.
- Flush: `flush_interval` default `1s`; lines appear about a second after a batch arrives.
  Pipelines here have no `batch` processor, so each received OTLP request becomes its own line. Fine for replay.
- `append: true` keeps data across collector restarts (container restart, same pod). A new pod starts empty.
- Disk: emptyDir uses node disk. With `logsCollection` and load-gen the files grow fast. Add
  `emptyDir: {sizeLimit: 2Gi}` (pod is evicted when exceeded) and copy often.

## 5. Metrics

Easy: one more exporter plus one more entry in the `metrics` pipeline (snippet above). The `demo-values.yaml` crash
note is about `awss3`. I found nothing like it for `fileexporter` in its README, but I did not read the source or the
issue tracker, so test it; if the collector crash-loops, drop `file/metrics`. Volume is large. Note `spanmetrics` feeds
the `metrics` pipeline, so span-derived metrics land in `metrics.jsonl`.

## 6. .gitignore

`.gitignore` has no `telemetry` entry (`grep` finds none; `git check-ignore telemetry` prints nothing).
Add: `/telemetry/`. It is anchored to the repo root and will not match `src/telemetry-docs`.
Also note `git status` shows `?? docs/` (untracked, not ignored) on this branch.

## 7. Repo specifics that change what is in the files

From `demo-values.yaml` and `CLAUDE.md`:
- `filter/drop_flagd_spans` runs first in `traces`: drops spans with `rpc.service == "flagd.evaluation.v1.Service"` and all
  spans from `service.name == "flagd"`. Orphaned cart `POST` spans (parent dropped) are expected; the files get the same
  filtered stream as Honeycomb.
- Processors run before exporters, so files hold transformed data: GenAI token attributes rewritten
  (`genai_copy_events_to_span`, `canonicalize`, `fix_token_counts`), service names renamed (`frontend` to `api-gateway`,
  `frontendproxy` to `ingress-gateway`), `collector.name=daemonset-collector` added (even in a deployment-mode run).
  Logs also get JSON body parsing, severity fixes, pino trace fields, and `drain` templates.
- Not in the files: `traces/evals` (Kafka) and `logs/markers` (Honeycomb markers). Separate pipelines.
- No Refinery or tail sampling sits between the collector and the file. Files hold everything the collector sees,
  unsampled. (`meta.span_count` and `trace_send_late_span` in CLAUDE.md describe Refinery output in Honeycomb, not the files.)
- `logsCollection` with `includeCollectorLogs: true` pulls in the collector's own logs. The file exporter does not log
  each write, so no feedback loop, but the sidecar and busybox logs also enter the stream.
- Collector self-telemetry goes directly to Honeycomb via `service.telemetry`, so it will not appear in `metrics.jsonl`.

## Fallback: awss3 (no rebuild)

The image already has `awss3exporter` with `marshaler: otlp_json`, and `demo-values.yaml` already wires it for traces
and logs to bucket `takeout-telemetry-samples`. Then `aws s3 sync` to `./telemetry`. No sidecar and no daemonset
problem (all pods write to the same bucket), but output is one object per batch, not three JSONL files; you must
concatenate. Needs bucket access. I did not re-read the awss3 README for this note.

## Recommended approach

1. Add `fileexporter v0.151.0` to `ocb-config.yaml` (local, uncommitted).
2. Add `/telemetry/` to `.gitignore`.
3. Create an untracked overlay with the snippet above; append to `valuesFiles` in `skaffold.yaml` (local edit).
4. `helm template` the overlay to check the render, then
   `AWS_PROFILE=devrel-sandbox ./run otelcollector <changed services>`. The OCB build takes a while.
5. Keep the daemonset (Option X). Run the copy loop in section 2, then concatenate per signal.
6. Do traces and logs first; add metrics after they work.
7. Work on a throwaway branch; do not commit to main.

## Open questions for Dr. Whaaaat?

- Is a collector image rebuild OK? It is the only way to get `fileexporter`.
- Do you need pod-log records (filelog) in `logs.jsonl`? If no, Option Y (one deployment pod) is simpler to copy from.
  If yes, use Option X.
- Is the S3 fallback acceptable? It avoids rebuild, sidecar and the multi-pod copy, but gives batch objects, not files.
- Can nodes pull `busybox` from Docker Hub, or must the sidecar image come from ECR?
- Must files survive redeploys? emptyDir does not; a PVC would.
