# Slow login story — plan

Agreed in a grilling session on 2026-09-27. Goal: show off Canvas Connectors with a
real incident caused by real code (not a pathology flag).

## The payoff

An incident is already open in incident.io and being worked in a Honeycomb Canvas.
The user asks something like "Check on the latest changes I made — could they have
caused this?" Honeycomb looks at **Linear** and **GitHub** for context, finds a ticket
the user recently closed and the related PR, figures out what happened, and updates
the incident in **incident.io**.

## The bug (real code)

- Our biggest customer, **Globex**, asked for a post-auth check: "is this employee
  still current?" It calls a URL that Globex serves.
- It shipped behind a flagd flag, `auth.user-status-check`, targeted at
  `company == globex` only. Everyone *believed* it was rolled out to everyone.
- Each tenant has an `enforce` setting. Only Globex has `enforce = true`, meaning a failed check blocks
  login. For everyone else the check **fails open**: log a warning, mark the span as an error,
  and let the login through.
- The check URL for tenants that never configured one comes from the tenant's domain:
  `https://sso-status.<company-domain>/v1/users/<id>`. For non-Globex tenants the
  TCP connect hangs until the **10s timeout**.
- A routine "remove stale feature flags" PR deletes the conditional (and the flagd
  entry, so the diff shows the Globex targeting rule going away). Now **every SSO
  login** runs the check, and every non-Globex SSO login takes about 10s more.
  Password logins and Globex are unaffected.

## What to build

### `auth` service (new, Go)
- gRPC `Login` RPC in `pb/demo.proto`, following the demo's service pattern
  (docker-compose, Helm values in `skaffold-config/demo-values.yaml`, Pulumi `deploy/`).
- Postgres `auth` schema (in `src/postgres/init.sql`): companies, users, per-tenant
  SSO config (method, status-check URL override, enforce).
- OpenFeature + flagd client; otelhttp for outbound calls.
- Mocked internals, **real-looking spans**:
  - Password tenants: hash check.
  - SSO tenants: HTTP call to an in-cluster mock IdP ("verify assertion"), then the
    user-status check.

### Mocks in the cluster
- Mock IdP: fast, always verifies.
- Globex's status endpoint (`sso-status.globex.example`): answers in about 50ms and sometimes
  says "not current", which blocks the login because Globex enforces the check.
- Other tenants' `sso-status.*` hosts must **hang**, not fail fast. Public DNS
  would return NXDOMAIN in milliseconds. Use `hostAliases` pointing at a blackhole address, or a
  tarpit service.

### Tenants
- About 40 generated companies on `.example` domains (a reserved TLD, so none are real).
- Globex gets about 35% of logins. About 60% of the remaining tenants use SSO; the rest use passwords.
- Result after the break: about 40% of logins take 10s; p50 barely moves while p90 and p99 blow up.

### Frontend
- Login page and header link.
- Logged-in identity lives in **sessionStorage** (like `Session.gateway.ts`), so it lasts
  only as long as the tab. No cookie.
- **Don't touch `app.user.id`**: it stays the session UUID. Add new fields
  `app.corporate_user.id` and `app.company` to spans and baggage.
- Pre-fill the checkout email. Nothing else changes; checkout still works logged-out.

### Load generator (important)
- New weighted `login` Locust task on `WebsiteUser`; existing tasks untouched.
- Must cover all three populations: **password-login companies**, **SSO companies**,
  and **Globex**.
- Realistic baseline noise: some bad passwords; some Globex users who fail the
  status check (and are blocked).

## Timeline in prod (devrel-demo)

1. **Release A**: auth service with the flag, targeted only at Globex. Runs healthy long
   enough to build a baseline.
2. **Release B**: the "remove stale feature flags" PR, with a deploy marker. The incident
   starts here. It is **left broken** on purpose, so there's always a live incident to demo.
   The fix is a later decision.

## External setup

- **GitHub**: real PRs merged in this repo (honeycombio/devrel-opentelemetry-demo).
- **Linear** (Honeycomb's real workspace):
  1. "Globex: verify employee still active after SSO", closed around release A with a note like
     "shipped behind `auth.user-status-check`, rolled out."
  2. "Remove stale feature flags", closed by Jess at release B, and lists that flag
     as fully rolled out.
- **Honeycomb trigger** (devrel-demos team): P95(duration_ms) of the auth `Login`
  span > 3000ms over 10 min, checked every 5 min. Not split by method; let the
  investigation find SSO, then non-Globex, then the check. Should page incident.io once, not keep re-firing.
- **incident.io**: no recipient exists yet (as of 2026-09-27 the team has only Slack and email
  recipients). Create an incident.io HTTP alert source and register it in Honeycomb
  as a webhook recipient.

---

# Implementation plan

Written 2026-09-27, after a second Q&A with Jess. Everything above is the agreed design;
this section is how we build it. Decisions made in that Q&A:

- **Real-looking hosts in traces.** Outbound spans show `sso.keystone-id.example` and
  `sso-status.globex.example`, never an in-cluster service name. The mocks run as a
  **sidecar in the auth pod**. Pod `hostAliases` map the mocked hosts to `127.0.0.1` and the
  other tenants' `sso-status.*` hosts to a blackhole IP.
- **Two decoy flags** ship in Release A: `frontend.login-link` and `auth.login-audit-log`.
  Both default to on with no targeting. Release B removes all three flags, so the Globex
  one is one of three.
- **Release A is two PRs**: PR 1 "Corporate login" and PR 2 "Globex: verify employee still
  active after SSO". Release B is PR 3 "Remove stale feature flags".
- **Plumbing skips PRs** (Jess, later the same day). The mocks, hostAliases/blackhole, the
  tenant seed and the loadgen are pushed straight to `main`, so the PR trail contains only
  story code. It's a demo app, so that's fine.

## Verified facts (2026-09-27; don't re-check unless something changed)

- **Blackhole hangs.** A pod in `jessitron-local` with hostAliases mapping
  `sso-status.acme.example → 192.0.2.1` ran `curl --connect-timeout 12`, which timed out at
  12.00s. No RST and no ICMP came back. `10.255.255.1` behaved the same. There are no
  NetworkPolicies in any namespace. **Use `192.0.2.1`** (TEST-NET-1, never routed).
- **Local and prod are the same EKS cluster.** `./run` deploys to `$USER-local`; prod is
  `devrel-demo`. So local verification transfers to prod.
- **Go honors hostAliases.** The checkout pattern (`CGO_ENABLED=0` on
  `distroless/static-debian12`) uses the pure-Go resolver, which reads `/etc/hosts` first.
- **flagd targets on context attributes.** Tested against the deployed image
  (`flagd:v0.12.8`). The Go provider (`go-sdk-contrib/providers/flagd v0.3.0`, RPC mode)
  sends the evaluation context as a `structpb`. Targeted results come back with reason
  `TARGETING_MATCH` and aren't cached, only `STATIC` results are.
  - Gotcha: context values must be scalars or `[]any`. `structpb` rejects a `[]string`.
- **flagd config has a single source**, `src/flagd/demo.flagd.json`. Local deploys load it
  through the skaffold hook `scripts/create-flagd-custom-config.sh`. Prod loads it through
  Pulumi `deploy/applications/oteldemo.ts:46`.
  - Both paths build the `flagd-custom-config` ConfigMap, which is copied into an emptyDir
    when the pod starts. A flag-file change therefore needs a **flagd pod restart** to take
    effect. Edits made in flagd-ui are lost when the pod restarts.
- **The upstream chart can't do hostAliases.** Chart 0.39.0's component schema has
  `additionalProperties: false` and no `hostAliases` field. So **auth goes in the in-repo
  chart `skaffold-config/charts/otel-services`**, which prod also uses
  (`deploy/applications/otel-services.ts:71`).
- **Prod Postgres has no persistence** (no volumes, no PVC). `init.sql` runs on every
  postgres pod start, and a new postgres image brings the new schema with it. As today,
  orders are wiped whenever postgres restarts.
- **Envoy needs no change.** Its catch-all `/` route already sends `/login` and
  `/api/login` to the frontend.
  - Envoy's default route timeout is 15s, which is more than the 10s check plus overhead.
- **Load volume.** Prod loadgen runs 10 users with `between(1,10)`, about 1.8 tasks/s at a
  total weight of 34. A `login` weight of **4** gives about 115 Login spans per 10-minute
  window, enough for a stable P95.
- **The OTel OpenFeature hook** (`hooks/open-telemetry v0.3.6`) adds a
  `feature_flag.evaluation` event to the span in `ctx`. The event has the key and variant,
  but no reason and no context. So set `app.company` on the span ourselves, and evaluate
  with the Login span's ctx.

## Naming

| Thing | Value |
|---|---|
| Service | `auth` (Go), gRPC port 8080, `AUTH_ADDR=auth:8080` |
| Mock sidecar | `sso-mocks` (Go, **uninstrumented**, because it stands in for third parties) |
| IdP host | `sso.keystone-id.example` (a fictional IdP vendor; tenant in the path) |
| Globex status host | `sso-status.globex.example` |
| Default status URL | `https://sso-status.<company-domain>/v1/users/<corporate_user_id>` |
| Blackhole | `192.0.2.1` for every non-Globex SSO tenant's `sso-status.<domain>` |
| New fields | `app.corporate_user.id`, `app.company` (slug, e.g. `globex`); `app.user.id` untouched |
| Flags | `auth.user-status-check` (targeted), `auth.login-audit-log`, `frontend.login-link` |

## 1. The `auth` service

### Proto (`pb/demo.proto`)
```proto
service AuthService { rpc Login(LoginRequest) returns (LoginResponse) {} }
message LoginRequest  { string email = 1; string password = 2; string method = 3; } // method: "password" | "sso"
message LoginResponse { string corporate_user_id = 1; string company = 2; string company_name = 3;
                        string email = 4; string display_name = 5; }
```
- Failures are gRPC status codes, not fields:
  - `Unauthenticated`: bad password or unknown email.
  - `FailedPrecondition`: the method doesn't match the tenant.
  - `PermissionDenied`: the status check says "not current" and the tenant enforces it.
  - otelgrpc follows semconv, so none of these mark the *server* span as an error. The
    errors we want (like a failed status check) show up on child spans.
- Regenerate everywhere: `make docker-generate-protobuf`. That covers checkout,
  product-catalog, product-reviews, the frontend TS protos, and the other languages.
- Add `auth` to `docker-gen-proto.sh`, `ide-gen-proto.sh`, the Makefile's
  `generate-protobuf` target, and the Makefile's clean list
  (`./src/{checkout,product-catalog,auth}/genproto/oteldemo/`).
- Register gRPC reflection so grpcurl works for testing.

### Code layout (`src/auth/`, copy checkout's shape)
- Files:
  - `main.go`: OTel init (trace, metric, log), copied from checkout.
  - `login.go`: the Login flow.
  - `db.go`: pgx pool with `github.com/exaring/otelpgx`.
  - `idp.go`: SSO verification.
  - `statuscheck.go`: added in PR 2.
  - `audit.go`
  - `genproto/`
  - `Dockerfile`
- Build like checkout: `golang:1.24-bookworm`, then `CGO_ENABLED=0`, running on
  `distroless/static-debian12:nonroot`. Each dir needs its own COPY line (checkout's
  Dockerfile copies dir by dir).
- Dependencies at checkout's versions: otel v1.38.0, otelgrpc/otelhttp v0.63.0,
  open-feature/go-sdk v1.17.0, flagd provider v0.3.0, otel hooks v0.3.6. Also
  `golang.org/x/crypto/bcrypt`, `jackc/pgx/v5`, `exaring/otelpgx`. Semconv: use whatever
  otelhttp v0.63 emits (stable HTTP semconv: `url.full`, `server.address`,
  `http.response.status_code`, `error.type`). Use `semconv/v1.26+` for any attributes we set
  by hand.
- Env:
  - `DB_CONNECTION_STRING=host=postgresql user=otelu password=otelp dbname=otel`
    (libpq style, same as product-reviews).
  - `FLAGD_HOST`, `FLAGD_PORT`, `AUTH_PORT`.
  - `SSL_CERT_DIR=/etc/ssl/certs:/etc/sso-mocks-ca`. Go reads colon-separated dirs and adds
    them to the system roots.
  - `OTEL_*` via the chart.

### Postgres (`src/postgres/init.sql` + generated seed)
- Add to `init.sql`, following the accounting/reviews pattern:
  `CREATE SCHEMA auth; GRANT USAGE ON SCHEMA auth TO otelu;` plus:
  ```sql
  auth.company (company_id text PK /*slug*/, name text, domain text UNIQUE,
                login_method text CHECK (login_method IN ('password','sso')),
                idp_tenant text NULL)
  auth.corporate_user (corporate_user_id text PK /*usr_…*/, company_id text FK, email text UNIQUE,
                display_name text, password_hash text NULL, last_login_at timestamptz NULL)
  auth.login_event (id bigint GENERATED ALWAYS AS IDENTITY, corporate_user_id text, company_id text,
                method text, result text, created_at timestamptz DEFAULT now())
  -- PR 2 adds (only Globex gets a row; see §3):
  auth.sso_status_check (company_id text PK FK, url_override text NULL, enforce boolean NOT NULL DEFAULT false)
  ```
  Grant `SELECT, INSERT, UPDATE` on the tables, and `USAGE` on the identity sequence
  (existing grants don't cover sequences).
- **Seed data is generated, not handwritten.** The generator is
  `scripts/generate-auth-tenants.py`, with a fixed random seed. Its outputs are committed:
  - `src/postgres/auth-seed.sql`, copied in the Dockerfile to
    `/docker-entrypoint-initdb.d/zz-auth-seed.sql` so it sorts after `init.sql`.
  - `src/load-generator/corporate_users.json`: email, company, method, and password. The
    password is known because it's a demo.
  - A hostAliases values fragment for the otel-services chart. It lists the IdP host and
    Globex's host (`127.0.0.1`) and every non-Globex SSO tenant's `sso-status.<domain>`
    (`192.0.2.1`).
  - The SAN list for the mock TLS cert.
- Tenants: 40 companies on `.example` domains.
  - `globex` / Globex Corporation / `globex.example` is SSO and has about 200 users.
  - The other 39 are SSO or password in a ~60/40 split (≈23 SSO, ≈16 password), with 10–40
    users each.
  - Names come from a generated list (e.g. `Initech`, `Umbrella Freight`, `Vandelay
    Imports`…); domains are `<slug>.example`.
- Passwords: one demo password for everyone, bcrypt cost 10. Hash per user in the generator
  so the salts differ.
  - This is **real bcrypt** in the service, about 50–80ms of CPU, so the `VerifyPassword`
    span is honest.

### Login flow and spans
Spans nest like this. Names are what shows up in Honeycomb.
```
oteldemo.AuthService/Login               (otelgrpc server span)
  ├─ SELECT otel.auth.corporate_user       (otelpgx; user ⨝ company ⨝ sso_status_check, one query)
  ├─ password tenants:  VerifyPassword     (internal; app.auth.hash_algorithm=bcrypt, app.auth.hash_cost=10)
  ├─ SSO tenants:       VerifySSOAssertion (internal; app.auth.idp=keystone-id)
  │     └─ POST                            (otelhttp client → https://sso.keystone-id.example/api/v1/tenants/<idp_tenant>/assertions/verify)
  │  [PR 2] CheckUserStatus                (internal; only when the flag says so — see §3)
  │     └─ GET                             (otelhttp client → https://sso-status.<domain>/v1/users/<id>)
  ├─ UPDATE otel.auth.corporate_user       (last_login_at)
  └─ INSERT otel.auth.login_event          (behind auth.login-audit-log)
```
- **Attributes on the Login span:**
  - `app.company`, `app.corporate_user.id`, `app.auth.method` (`password|sso`).
  - `app.auth.result` (`success|bad_password|unknown_user|method_mismatch|user_not_current`).
  - `app.auth.email_domain`: the domain only, not the full email.
  - `app.user.id` and `session.id` are copied from baggage if present. That's the same
    session UUID, unchanged.
- **Outbound HTTP:** `&http.Client{Timeout: 10*time.Second, Transport: otelhttp.NewTransport(http.DefaultTransport)}`.
  Use `otelhttp.WithSpanNameFormatter` so the span name is the bare method (`GET`/`POST`),
  per semconv, if v0.63 doesn't already do that. Check this in commit A4.
- **Logs** go through `otelslog`, like checkout, so they correlate with traces.
- **Metrics:** one counter, `app.auth.logins`, with attributes `{company, method, result}`.
  This is cheap and makes the service look lived-in.
- **Mock behavior** (in `sso-mocks`; no OTel, since a real IdP wouldn't send us spans):
  - IdP verify: 20–60ms of jitter, always `{"valid": true}`.
  - Globex status: 30–70ms. Users whose `hash(corporate_user_id) % 25 == 0` get
    `{"status":"terminated"}` (about 4%, and the same users every time). Everyone else gets
    `{"status":"active"}`.
  - Listens on `127.0.0.1:443` with TLS. The cert has SANs for the two mocked hosts and
    comes from a committed demo CA (`src/sso-mocks/certs/`, generated by
    `scripts/generate-sso-mock-certs.sh`).
  - Binding :443 as nonroot: if containerd doesn't already allow it, set the pod sysctl
    `net.ipv4.ip_unprivileged_port_start=0`. It's a "safe" sysctl, so no cluster change is
    needed. Check this in commit A4.

## 2. In-cluster mocks and the blackhole

Changes to the `otel-services` chart (`skaffold-config/charts/otel-services`):
- `values.yaml`: add `services.auth` in the same shape as storechat: `name: auth`, image
  `latest-auth`, port 8080, env.
  - Add `services.auth.hostAliases` (from the generated fragment).
  - Add `services.auth.sidecar` (image `latest-sso-mocks`).
- `templates/deployment.yaml`: add an `auth` Deployment block, copied from storechat's. Add
  `hostAliases:` under `spec.template.spec`, the second container, and a ConfigMap volume
  for the CA (from `files/sso-mocks-ca.pem` via `.Files.Get`) mounted at
  `/etc/sso-mocks-ca`.
- `templates/service.yaml`: add an `auth` Service on 8080. Nothing exposes the mocks.

Keep the naming bland. The blackhole list lives in values as
`services.auth.hostAliases`, with a one-line comment: "tenant-hosted endpoints; not
reachable from the demo cluster". Don't mention hanging, timeouts, or the story.

**Keeping it out of the PR trail:** all of this simulation plumbing is **pushed directly
to `main`, with no PR** (see §6, "How things land"). The Canvas agent follows Linear → PRs,
so it never sees a diff containing `192.0.2.1 sso-status.<tenant>`. The entries are still
in the repo for anyone who greps deploy config. That's acceptable, since this is a demo
app.

The one visible trace of the trick is Go's timeout error text, which includes the IP:
`dial tcp 192.0.2.1:443: i/o timeout (Client.Timeout exceeded …)`. If that reads too fake,
`203.0.113.x` (TEST-NET-3) looks a bit less like a documentation address and hangs the
same way.

## 3. The flag `auth.user-status-check` (PR 2)

In `src/flagd/demo.flagd.json`:
```json
"auth.user-status-check": {
  "description": "Post-SSO employee status check (Globex)",
  "state": "ENABLED",
  "variants": { "on": true, "off": false },
  "defaultVariant": "off",
  "targeting": { "if": [ { "==": [ { "var": "company" }, "globex" ] }, "on", "off" ] }
}
```
- This is the first flag in the file with `targeting`. The agent tested the inverted form,
  and this orientation behaves the same.
- In `login.go`, after SSO verification succeeds, and only for SSO:
  ```go
  evalCtx := openfeature.NewEvaluationContext(user.ID, map[string]any{"company": user.CompanyID})
  if check, _ := flags.BooleanValue(ctx, "auth.user-status-check", false, evalCtx); check {
      if err := statusCheck.Verify(ctx, user); err != nil { ...enforce vs fail-open... }
  }
  ```
  `ctx` is the Login span's context, so the `feature_flag.evaluation` event lands on
  Login.
- `statusCheck.Verify`:
  1. The URL is `url_override` if set, otherwise `https://sso-status.<domain>/v1/users/<id>`.
  2. It sets `CheckUserStatus` span attributes: `app.auth.status_check.enforced` and
     `app.auth.status_check.result` (`active|not_current|error`).
  3. On a transport error or non-2xx:
     - `span.RecordError` and `SetStatus(Error)`.
     - `logger.Warn("user status check failed", …)`.
     - If `enforce`, fail the login with `PermissionDenied`. Otherwise **allow** it (fail
       open) and set `app.auth.status_check.fail_open=true`.
  4. On `terminated`: `app.auth.result=user_not_current`. If enforcing, `PermissionDenied`.
     If not enforcing, log and allow. This can't happen before Release B.
- Seed data: **only Globex has a `sso_status_check` row** (`enforce=true`,
  `url_override NULL`). The Login query `LEFT JOIN`s the table, and a missing row means
  "default URL, don't enforce". So Globex's configuration is data, pushed with the seed,
  and PR 2's diff is generic multi-tenant code.
  - The code already handles every tenant, which is what makes the Release B cleanup look
    safe.

## 4. Frontend (`src/frontend`)

- **Session** (`gateways/Session.gateway.ts`): extend `ISession` with optional flat fields
  `corporateUserId`, `company`, `companyName`, `corporateEmail`, `displayName`.
  - Keep them flat because `_app.tsx` spreads the session into `OpenFeature.setContext`.
  - Add a `clearCorporateLogin()`.
  - Storage stays sessionStorage, key `session`, no cookie.
- **RPC:** add `gateways/rpc/Auth.gateway.ts` (copy `Checkout.gateway.ts`, reading
  `AUTH_ADDR`). Add `pages/api/login.ts`: POST only, wrapped in `InstrumentationMiddleware`.
  - It maps gRPC codes to HTTP: `Unauthenticated`→401, `PermissionDenied`→403,
    `FailedPrecondition`→409.
  - It sets `app.company` and `app.corporate_user.id` on the active span.
- **Page:** `pages/login.tsx` has an email field, a password field, a **Sign in** button
  (`method=password`) and a **Sign in with SSO** button (`method=sso`, which ignores the
  password).
  - On success it writes the session fields and goes to `/`.
  - On error it shows the message.
- **Header** (`components/Header/Header.tsx`):
  - Logged out, it shows a "Log in" link.
  - Logged in, it shows `companyName · displayName` and "Log out".
  - The link is gated with `useBooleanFlagValue('frontend.login-link', false)` from
    `@openfeature/react-sdk`, which is already a dependency. That's the decoy flag.
- **Baggage** (`gateways/Api.gateway.ts:114-133`): when present, also set
  `app.corporate_user.id` and `app.company` in baggage, next to `session.id`.
- **Browser spans:** extend `utils/telemetry/SessionIdProcessor.ts` so `onStart` reads the
  session fresh each time (it caches `userId` at import today) and sets the two new
  attributes when present.
  - `HoneycombFrontendTracer.ts` builds its own config, so add the same thing there through
    a span processor if the SDK's `spanProcessors` option is available. Otherwise use the
    `beforeSpanStart`-style hook where it already sets `app.synthetic_request`.
- **Server-side spans:** API routes read the two baggage entries and set them as
  attributes. Do this in `InstrumentationMiddleware` so every route gets them.
- **Checkout email** (`components/CheckoutForm/CheckoutForm.tsx:46`): the initial state is
  `session.corporateEmail ?? 'someone@example.com'`. That's the only checkout change.
- **Env:** add `AUTH_ADDR=auth:8080` to `components.frontend.envOverrides` in both
  `deploy/config-files/demo/values.yaml` and `skaffold-config/demo-values.yaml`, next to
  `PRODUCT_REVIEWS_ADDR`, and to docker-compose/.env.

## 5. Load generator (`src/load-generator/locustfile.py`)

- Load `corporate_users.json` next to `people.json`, and group it into three populations:
  Globex, other SSO tenants, and password tenants.
- Add `@task(4) def login(self)`:
  1. Pick a population: 35% Globex; otherwise a uniformly random non-Globex *tenant*, which
     yields the ~60/40 SSO/password split.
  2. Pick a random user in that population.
  3. SSO users POST `{email, method:"sso"}`. Password users POST
     `{email, password, method:"password"}`, and 6% of the time the password is wrong.
  4. 1% of the time, use an unknown email at a known domain.
  5. Use `catch_response` so 401/403 aren't counted as Locust failures. Mark 5xx as
     failures.
- Globex users whose status comes back "terminated" get a 403 naturally, from the mock.
  The loadgen doesn't need to know which users those are.
- Leave the existing tasks, weights and `on_start` alone. Baggage (`synthetic_request`,
  `session.id`) already rides on every request.
- Also set the login result into baggage? **No.** Checkout still uses `random_email()`, and
  the loadgen doesn't need to act logged-in.
- Add `corporate_users.json` to the load-generator Dockerfile COPY.

## 6. Release A — commit sequence

### How things land
The PR trail is the story, so **only story code goes through PRs**. Everything that exists
only to simulate the outside world or make traffic is **committed straight to `main` and
pushed, with no PR**:
- the tenant generator and seed data,
- the mocks, certs and hostAliases,
- the loadgen login task,
- test scripts.

The Canvas agent follows Linear → PR → diff and never sees that plumbing.

The rule for every commit: **it's either story or plumbing, never both.** Each commit below
is tagged **PR 1**, **PR 2** or **main**.

Workflow:
1. Develop on one local branch off `main` (e.g. `jessitron/corporate-login`), in the order
   below, so every commit is testable with `./run` as it's written.
   - Keep it off `jessitron/slow-login-story`, which carries the temporary CLAUDE.md focus
     commit and the grilling skill.
2. When it works end to end, land it in the order under "Landing order" below. Reorder with
   `git rebase` so each group is a contiguous run of commits.
3. Direct pushes to `main` work. Jess has done it before, so no branch-protection bypass is
   needed.

`./run`: `AWS_PROFILE=devrel-sandbox ./run <services>`. Note that `.skaffold.env` currently
says `martin-devrel-sandbox`.

Honeycomb checks: resolve the destination with `scripts/local-honeycomb-destination.sh`.
For Jess that's team `modernity`, env `devrel-demo--local-`, via the
`honeycomb-devrel-demo` MCP server. See CLAUDE.md.

### Development order
| # | Lands via | Commit | `./run` | Verify |
|---|---|---|---|---|
| A1 | PR 1 | Add `AuthService` to demo.proto; regenerate all stubs | `checkout product-catalog frontend` (build check) | Existing traffic is unchanged; checkout and frontend spans still show up. |
| A2 | PR 1 | `auth` schema in init.sql (tables and grants, no rows) | `postgresql` | `\dt auth.*` shows the tables. |
| M1 | main | Tenant generator, `auth-seed.sql`, `corporate_users.json`, and `scripts/query-auth-tenants.sh` | `postgresql` | The query script shows 40 companies, Globex at about 200 users, and the SSO/password counts. |
| A3 | PR 1 | `auth` service: DB lookup, bcrypt, and the password path. The SSO path calls the IdP over HTTP. Also chart, skaffold, compose, CI and Pulumi wiring for `auth` | `auth postgresql` | `scripts/auth-login.sh <email> <pw>` (grpcurl in a temp pod; lands with M2) returns a user. In Honeycomb, `service.name=auth` shows `Login`, then `SELECT`, then `VerifyPassword` (~60ms), then `UPDATE`. A wrong password gives `app.auth.result=bad_password`, and the span isn't marked as an error. SSO logins fail for now: the IdP host doesn't resolve yet. |
| M2 | main | `sso-mocks` (IdP verify + Globex status endpoint), TLS CA and certs, and the otel-services chart changes for auth: sidecar, CA volume, `SSL_CERT_DIR`, generated `hostAliases` (mocked hosts → 127.0.0.1, other SSO tenants' `sso-status.*` → 192.0.2.1), plus build and CI wiring for `sso-mocks` | `auth sso-mocks` | An SSO user logs in, with a `POST` child span to `server.address=sso.keystone-id.example`, ~40ms, status 200. Check the span name format and the :443 bind. **Blackhole check:** `kubectl debug` into the auth pod with a curl image and time `curl https://sso-status.initech.example`. It should take ≈10s or more. |
| A4 | PR 1 | Frontend: login page, header, session, `/api/login`, baggage and attributes, checkout email prefill, `AUTH_ADDR` | `frontend` | Log in at `http://127.0.0.1:919x/login` as a password user and as an SSO user. One trace runs from the browser span through `POST /api/login` and `oteldemo.AuthService/Login` to its children. Browse and check out: `app.company` is on frontend spans, the email is pre-filled, and `app.user.id` is still the UUID. |
| A5 | PR 1 | Decoy flags `frontend.login-link` and `auth.login-audit-log` (with the `login_event` insert) | `auth frontend` (the flagd file ships with the chart deploy) | The header link shows. `INSERT otel.auth.login_event` appears in the trace, and Login has a `feature_flag.evaluation` event. Turning the flags off in flagd-ui hides the link and stops the insert. |
| M3 | main | Loadgen `login` task | `load-generator` | After ~15 minutes, Login `COUNT` by `app.company` shows Globex at ≈35%. By `app.auth.method`, about 40% of non-Globex logins are password. `app.auth.result` has a few `bad_password` and `unknown_user`, and no `user_not_current` yet. Login P95 is under 300ms. |
| A6 | PR 2 | `sso_status_check` table in init.sql; `CheckUserStatus` in auth behind `auth.user-status-check` (flagd entry targeted at `company == globex`) | `postgresql auth` (+ restart flagd) | No rows yet, so nothing is enforced: Globex logins run the check, but terminated users still get in. |
| M4 | main | Seed the Globex `sso_status_check` row (`enforce=true`) | `postgresql` | Globex SSO logins have `CheckUserStatus`, then `GET sso-status.globex.example` (~50ms). About 4% get `user_not_current` and a 403. Non-Globex SSO logins have **no** `CheckUserStatus` span. Login's `feature_flag.evaluation` event shows `on` for Globex and `off` for everyone else. |
| — | — | *(not a commit)* Local dress rehearsal of the break | — | In flagd-ui, set `auth.user-status-check` to default `on` and remove the targeting. Non-Globex SSO Login p95 should be ≈10s, with `CheckUserStatus` error `i/o timeout`, `fail_open=true`, and the login still succeeding. P50 across all Logins barely moves. Then **restart flagd** to restore. |

Wiring a new service touches these places. `auth`'s wiring goes in A3; `sso-mocks`'s goes
in M2:
- `skaffold.yaml`: build artifacts, plus `setValueTemplates` under the
  `{{.USER}}-otel-services` release (`services.<x>.imageOverride.*`).
- `skaffold-config/charts/otel-services/{values.yaml,templates/*}`.
- `deploy/applications/otel-services.ts`: `services.<x>.image.tag: ${containerTag}-<x>`.
- `.github/workflows/release-devrel.yml`: matrix entries (`file`, `tag_suffix`,
  `context: ./`, `setup-qemu: true`).
- `docker-compose.yml` and `.env` (`AUTH_ADDR`, `AUTH_PORT`, `AUTH_DOCKERFILE`). Compose
  uses `extra_hosts` where k8s uses hostAliases. Wire it for completeness; don't test it.

### Landing order
1. **PR 1 "Corporate login"**: A1, A2, A3, A4, A5. Merge it.
2. **Push to main**: M1, M2, M3, rebased onto the merged PR 1.
3. **PR 2 "Globex: verify employee still active after SSO"** (links Linear ticket 1): A6.
   Merge it.
4. **Push to main**: M4.

Between steps, `main` may briefly have SSO without mocks. That's harmless: nothing reaches
prod until the tag.

Then tag: `./scripts/bump-release.sh minor`. That builds images, runs `pulumi up` on
`prod-aws`, and posts a deploy marker.
- In prod, check the M3 and M4 numbers again against `devrel-demo`.
- Let it run long enough (at least a few days) for a clear baseline.
- Close Linear ticket 1.

## 7. Release B: "Remove stale feature flags" (PR 3)

The diff is three small, boring edits plus the JSON. PR description:
> Cleaning up flags that have been fully rolled out for a while: `frontend.login-link`,
> `auth.login-audit-log`, `auth.user-status-check`. No behavior change intended.

- `Header.tsx`: drop `useBooleanFlagValue('frontend.login-link')`, so the link always
  renders.
- `audit.go`/`login.go`: drop the `auth.login-audit-log` check, so auditing always happens.
- `login.go`: replace
  `if check, _ := flags.BooleanValue(ctx, "auth.user-status-check", …); check {`
  with the unconditional call. The `evalCtx` construction goes away too. (That's natural:
  no other flag uses it.)
- `demo.flagd.json`: delete all three entries. The Globex `targeting` block is visible in
  the diff but sits among the rest.
- No comments in code or PR that hint at tenants, timeouts, or Globex. Commit message:
  `Remove stale feature flags`. Link Linear ticket 2.
- Tag `./scripts/bump-release.sh patch`. The deploy marker "Deployed x.y.z to devrel-demo"
  comes from CI. Close ticket 2.
- **flagd note:** the Pulumi deploy updates the ConfigMap, but flagd only reads it at pod
  start. It doesn't matter here, because the *code* no longer asks. The incident starts as
  soon as the new auth pod is live, whether or not flagd restarts.

Expected after B: about 40% of logins (non-Globex SSO) take about 10s. The Login P95 jumps
from about 200ms to about 10s, and the trigger fires within one to two 5-minute
evaluations. Password and Globex logins are unchanged.

## 8. External setup checklist

**Linear** (Honeycomb workspace; pick a real-looking team, e.g. whichever team owns demo
work):
- [ ] Ticket 1: **"Globex: verify employee still active after SSO"**
  - Body: "Globex (our largest account) wants us to call their employee-status endpoint
    after SSO and block logins for anyone who's no longer current. Spec: GET
    `https://sso-status.<domain>/v1/users/<id>` → `{status: active|terminated}`. Should be
    per-tenant configurable; Globex enforces."
  - Link PR 2. Close at Release A with the comment: "Shipped behind
    `auth.user-status-check`, rolled out."
- [ ] Ticket 2: **"Remove stale feature flags"**
  - Body: "These are fully rolled out and can go: `frontend.login-link`,
    `auth.login-audit-log`, `auth.user-status-check`."
  - Assign to Jess, link PR 3, close at Release B.
- [ ] Space the dates realistically. Ticket 1 closes days to weeks before ticket 2.

**incident.io** (Jess, planned for 2026-09-28):
- [ ] Get **owner** permission on our incident.io team. Creating alert sources needs it.
- [ ] Create an **HTTP alert source**. Copy its URL and the bearer token or secret.
- [ ] Route it with an alert route that creates an incident (or a paging workflow) with a
      sensible severity.

**Honeycomb (devrel-demos team, `devrel-demo` env):**
- [ ] Create a **webhook recipient** pointing at the incident.io alert-source URL, with the
      incident.io auth header or secret. (None exists yet; the team only has Slack and
      email.)
  - Payload: use a custom webhook template, if incident.io's HTTP source wants specific
    fields (title, description, deduplication key = trigger ID, status firing/resolved).
    Check incident.io's docs at setup time.
- [ ] Create the **trigger** "Auth login latency":
  - Query: `P95(duration_ms)` where `service.name = auth` and
    `name = oteldemo.AuthService/Login`. No group-by.
  - Range 10 min (600s), frequency 5 min (300s), threshold `> 3000`.
  - Alert type **on change** (`alert_type: on_change`), so it fires once when it goes red
    and doesn't re-page every 5 minutes. Recipient: incident.io.
  - Create it **after** Release A has baseline data, and test-fire it before Release B.
- [ ] Before the demo, open the incident (from the trigger firing after B) and start the
      Canvas on it. Confirm the Linear and GitHub connectors can see the tickets and
      PRs 2 and 3.
