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
