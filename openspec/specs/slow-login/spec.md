# Slow Login After a Flag Cleanup Specification

## Purpose

This use case gives people and agents using Honeycomb a genuine incident to investigate and trace back to the change
that caused it. After a release that looks like routine flag cleanup, most corporate single sign-on (SSO) logins take
about 10 seconds longer, though nothing fails. The investigator works in a Honeycomb Canvas with the Linear, GitHub
and incident.io connectors. They start from the incident that the "Login latency check" trigger opens, use the auth
data to find which logins are slow (by method and company) and why (a post-SSO employee status check that waits for
a timeout), and then connect that to the release deploy marker, the flag cleanup change (Linear DVR-122) and the
earlier customer request that introduced the check (Linear DVR-121).
The same corporate accounts support customer-centric questions in Honeycomb: "which company is affected?", "what
changed for them?", "is this login slow for password users or SSO users?".

**The story.**

- The model is multi-tenant. A tenant is a company. Each company signs in with either a password or single sign-on
  (SSO), never both. The biggest fictional customer is Globex. Login is optional: browsing, cart and checkout never
  require it.
- Globex asked for a check after SSO that the employee is still current (Linear issue DVR-121). It ships behind the
  flagd flag `auth.user-status-check`, targeted at Globex only. Other tenants never configured a status endpoint,
  so a default address on their domain is used. That address is unreachable, and those tenants are not enforced, so
  for them the check fails open: the login still succeeds, after waiting for a 10 second timeout.
- The incident is a release in which the Globex targeting of the flag is gone (a "Remove stale feature flags"
  cleanup, Linear issue DVR-122), so the check runs for every SSO login. From the deploy of that release on,
  non-Globex SSO logins take about 10 seconds longer. Password logins and Globex logins are not affected.
- The demo's normal state is healthy: the flag and its Globex targeting are in place.

**What the demo shows in Honeycomb** (auth dataset, after the deploy marker):

- `oteldemo.AuthService/Login`: P95 `duration_ms` rises from about 130 ms to about 10 s, grouped by
  `demo.auth.method` and `demo.company`. About 40% of logins are affected. Login volume drops because load
  generator users wait on their login.
- `CheckUserStatus` spans: `demo.auth.status_check.result = error`, `demo.auth.status_check.enforced = false`, P95
  about 10 s, groupable by `parent.demo.company`.
- A Honeycomb trigger "Login latency check" (P95 of Login `duration_ms` over 500, evaluated every 5 minutes) sends a
  webhook that opens an incident in incident.io. The trigger, the incident.io setup and the connectors live outside
  the demo and depend on the names defined here.

## Apps affected

- `auth` (gRPC service): authenticates corporate users, runs the post-SSO status check, writes the audit trail,
  emits login telemetry. It is the only client of the stand-ins below.
- `postgresql` (the demo's database): tenants, users, login events, per-tenant status-check settings, and the
  seeded demo data.
- `sso-mocks` (deliberately minimal): stands in for the third-party identity provider and for Globex's
  employee-status endpoint.
- `frontend`: login page, header account area, HTTP login route, telemetry tagging of the corporate identity.
- `load-generator`: a login behavior for the plain-HTTP user class and a list of corporate users to log in as.
- `flagd`: flags `auth.user-status-check`, `auth.login-audit-log` and `frontend.login-link`.
- The shared RPC definitions carry the `AuthService` contract.
- The demo environment: name resolution and trust for the third-party hostnames.

## Requirements

### Requirement: The slow-login incident is reproducible from a healthy baseline

The demo SHALL start healthy: with the flag targeting in place, non-Globex SSO logins take about as long as the
identity-provider call. The incident SHALL be re-creatable by a release in which the status check runs for every SSO
login (for example by deleting the flag's `company == globex` targeting), and SHALL begin as soon as that release of
`auth` is live. Reverting that change SHALL restore the healthy state.

#### Scenario: Healthy state

- **WHEN** an SSO user of a company other than Globex logs in and the flag is targeted at Globex
- **THEN** no `CheckUserStatus` span is produced and the login takes about 130 ms in total

#### Scenario: Incident

- **WHEN** the check runs for every SSO login
- **THEN** non-Globex SSO logins show a 10 s `CheckUserStatus` error span and a Login `duration_ms` of about 10 s, and password logins and Globex logins are unchanged in speed

### Requirement: The demo has 40 seeded companies and 1035 corporate users

The demo database SHALL be seeded at creation with deterministic, generated data (rerunning the generator gives
the same data) that the load generator and the story rely on:

- 40 companies: Globex (`company_id` `globex`, name "Globex Corporation", domain `globex.example`, SSO, identity
  tenant `globex-b67476`) plus 39 other fictional companies. Every `company_id` is a slug of the name, the domain is
  `<company_id>.example`, and the identity tenant of an SSO company is `<company_id>-<6 hex characters>`.
- Of the 39 others, 23 use SSO and 16 use passwords (about 59% SSO).
- Globex has 200 users. Every other company has between 10 and 40 users. In total there are 1035 users (657 SSO,
  378 password).
- User emails look like `first.last@<domain>` (lower case, hyphens removed), for example
  `pavel.reyes@globex.example`.
- Every password-company user has the same demo password `stargazer-2026`, stored as a bcrypt hash with cost 10. SSO
  users have no password.
- Exactly one status-check setting exists: Globex, with `enforce = true` and no URL override.

The seed, the load generator's user list and the hostname resolution for the status hosts SHALL all be generated
from one tenant list, so they always agree.

#### Scenario: Globex user can use SSO

- **WHEN** `pavel.reyes@globex.example` logs in with `method = "sso"`
- **THEN** the login can succeed (unless the status check denies the user)

### Requirement: Corporate users sign in through `AuthService.Login`

The system SHALL provide a gRPC service `oteldemo.AuthService` with one RPC, `Login(LoginRequest) returns
(LoginResponse)`.
`LoginRequest` has `email` (string), `password` (string) and `method` (string, `"password"` or `"sso"`).
`LoginResponse` has `corporate_user_id`, `company` (the company slug), `company_name`, `email` and `display_name`.
The service SHALL listen on the port given by the `AUTH_PORT` environment variable, answer the standard gRPC health
check, and read feature flags from flagd. A flag that cannot be evaluated is treated as off.

#### Scenario: Successful password login

- **WHEN** `Login` is called with a known password-tenant email, the right password and `method = "password"`
- **THEN** the response carries that user's id, company slug, company name, email and display name

#### Scenario: Method defaults to password

- **WHEN** `Login` is called with an empty `method`
- **THEN** it is handled as `"password"`

#### Scenario: Case-insensitive input

- **WHEN** the email or method is sent in different letter case than stored
- **THEN** the email is matched in lower case and the method is lower-cased before it is used

### Requirement: A user signs in only with their company's method

The system SHALL store companies (slug, name, email domain, login method `password` or `sso`, and, for SSO
companies only, an identity-provider tenant id), corporate users (id, company, unique email, display name, password
hash for password companies only, last login time) and per-company status-check settings (optional URL override,
`enforce`). A user is found by email alone. The email's domain identifies the company. A user logs in only with the
method their company uses.

#### Scenario: Method does not match the company

- **WHEN** a user whose company uses SSO sends `method = "password"` (or the reverse), or any method other than `password` or `sso`
- **THEN** the call fails with gRPC `FAILED_PRECONDITION` and the message "`<Company name>` uses `<sso|password>` sign-in"
- **AND** the result is `method_mismatch`

#### Scenario: Unknown email

- **WHEN** the email matches no user
- **THEN** the call fails with `UNAUTHENTICATED` and the message "invalid email or password"
- **AND** the result is `unknown_user`

#### Scenario: Last login is recorded

- **WHEN** a login succeeds
- **THEN** that user's last login time is updated

### Requirement: Password logins are verified against the stored hash

For a password company the system SHALL compare the submitted password against the stored bcrypt hash (cost 10)
inside a child span named `VerifyPassword`. That span carries `demo.auth.hash_algorithm` (`bcrypt`),
`demo.auth.hash_cost` (int) and `demo.auth.password_match` (bool). A wrong password fails with `UNAUTHENTICATED` and
the same message as an unknown email ("invalid email or password"), with result `bad_password`.

#### Scenario: Wrong password

- **WHEN** a known password-tenant user sends a wrong password
- **THEN** the call fails with `UNAUTHENTICATED`, `demo.auth.password_match = false`, and result `bad_password`

### Requirement: SSO logins are verified by the company's identity provider

For an SSO company the system SHALL ask the company's identity provider (Keystone ID) to verify the user, in a child
span named `VerifySSOAssertion` with `demo.auth.idp` (`keystone-id`) and `demo.auth.idp_tenant` (the company's
provider tenant id). It sends an HTTPS `POST` to
`https://sso.keystone-id.example/api/v1/tenants/<idp_tenant>/assertions/verify` with JSON body
`{"subject": "<email>"}` and treats `{"valid": true}` with HTTP 200 as success. The browser never sends a password
for SSO. The call is simulated, so there is no real redirect flow.
Every outbound HTTP call from this service has a 10 second client timeout. Outbound HTTP client spans are named only
by the HTTP method (for example `POST`, `GET`).
If the provider is unreachable, answers non-200, or answers `valid: false`, the login fails with gRPC `UNAVAILABLE`
and the message "single sign-on is unavailable", and the result is `idp_error`.

#### Scenario: Normal SSO login

- **WHEN** an SSO-tenant user logs in with `method = "sso"` and the identity provider answers `valid: true`
- **THEN** the call succeeds with result `success`

#### Scenario: Identity provider down

- **WHEN** the identity provider cannot be reached
- **THEN** the call fails with `UNAVAILABLE`, the `VerifySSOAssertion` span has error status, and the result is `idp_error`

### Requirement: The post-SSO status check runs only for Globex while the flag targeting is in place

The flagd flag `auth.user-status-check` SHALL control the status check. It is enabled, boolean, with variants
`on` = true and `off` = false, description "Post-SSO employee status check (Globex)", and default variant `off`.
Its targeting returns `on` when the evaluation context attribute `company` equals `globex`, otherwise `off`. It
carries the metadata `schedulable: false`, so the flagd-ui scheduler never flips it. The targeting SHALL be present
in the shipped flag file in the healthy state.
The auth service SHALL evaluate the flag for every SSO login, after the identity provider accepted the user, with the
corporate user id as the targeting key and `company` set to the company slug, and SHALL run the check only when the
flag is on. Password logins never run it. The flag is evaluated on each login and not cached by the service, so a
change in flagd takes effect for new logins.

#### Scenario: Globex user

- **WHEN** an SSO user of Globex logs in
- **THEN** a `CheckUserStatus` span is produced

#### Scenario: Password user

- **WHEN** a password user logs in
- **THEN** the flag is not consulted and no `CheckUserStatus` span is produced

#### Scenario: Targeting

- **WHEN** the flag is evaluated with `company = globex`
- **THEN** it returns `on`; for any other company it returns `off`

### Requirement: The status check calls the tenant's status address, by default on its own domain

The check SHALL be a child span of the Login span named `CheckUserStatus`, doing an HTTPS `GET` to
`<status URL>/<corporate user id>` that returns JSON `{"status": "<value>"}`. `"active"` means still employed. Any
other value means not current. The status URL is the tenant's configured override when it has one. Otherwise it is
`https://sso-status.<company domain>/v1/users/<id>`, the conventional address on the tenant's domain. The same 10
second client timeout applies as for other outbound calls. A non-200 answer or an unreadable body is a failed check.

#### Scenario: Tenant without a configured URL

- **WHEN** the check runs for a company with no override
- **THEN** the request goes to `https://sso-status.<company-domain>/v1/users/<user id>`

### Requirement: Only Globex is blocked by the status check; other tenants fail open

Each company has an `enforce` setting. A company with no setting SHALL NOT be enforced.

- **Enforced tenant** (only Globex): a user whose status is not `active` is denied with gRPC `PERMISSION_DENIED`,
  message "your account is not active at your company", result `user_not_current`. A failed check (error, timeout)
  is also denied, with the same code and message, and result `status_check_failed`.
- **Not enforced tenant:** a not-current status or a failed check is recorded but the login succeeds (result
  `success`). A failure is logged as a warning.

#### Scenario: Globex employee who left

- **WHEN** a Globex SSO user is reported as not active
- **THEN** login fails with `PERMISSION_DENIED`, result `user_not_current`, `demo.auth.status_check.result = not_current`, `demo.auth.status_check.enforced = true`

#### Scenario: Other tenant, unreachable endpoint (the slow login)

- **WHEN** the check is on for an SSO user of a non-Globex company and the endpoint cannot be reached
- **THEN** the call to the endpoint takes about 10 seconds and fails
- **AND** the login succeeds with result `success`, so `oteldemo.AuthService/Login` `duration_ms` is about 10 s

### Requirement: Default status addresses hang instead of refusing

For the story to be a 10 second slowdown, the demo environment SHALL make the default status host of every SSO
tenant except Globex (`sso-status.<company domain>`) resolve to an address that never answers (a non-routable
address), so connections hang until the client timeout. A fast "connection refused" or DNS failure would not produce
the slowdown. The tenant list drives this. The identity-provider host and Globex's status host resolve to the
`sso-mocks` stand-in.

#### Scenario: Time to failure

- **WHEN** the check is on for a non-Globex SSO company
- **THEN** the failure happens at the 10 second timeout, not immediately

### Requirement: Every login is described by span attributes, a counter and a log

Every `Login` call SHALL produce, on the `oteldemo.AuthService/Login` server span: `demo.auth.method`,
`demo.auth.email_domain` (lower-cased domain part of the email), `demo.auth.result`, and, once the user is known,
`demo.company` (company slug) and `demo.corporate_user.id`. When the caller supplied `session.id` in W3C baggage, the
span also carries `session.id` and `user.id` with that value.
The result values are exactly: `success`, `bad_password`, `unknown_user`, `method_mismatch`, `idp_error`,
`user_not_current`, `status_check_failed`, `error`. `error` means an internal failure, such as a database error, and
returns gRPC `INTERNAL`. Database queries made by the service appear as child spans.
The service SHALL also:

- increment the counter `demo.auth.logins` (unit `{login}`) once per call with attributes `demo.company` (empty
  string when the user is unknown), `demo.auth.method` and `demo.auth.result`;
- write one info log record `login` with `company`, `method` and `result`.

A `CheckUserStatus` span SHALL carry `demo.auth.status_check.enforced` (bool) and `demo.auth.status_check.result`,
which is one of `active`, `not_current` or `error`. On a failed check the span records the error and has error
status, with `result = error`; the failed outbound HTTP request is a child span of it. No extra "fail open"
attribute exists: `enforced = false` together with `result = error` tells that story. Because the span is a child
of the Login span, which carries `demo.company`, an operator can group `CheckUserStatus` by `parent.demo.company`.

#### Scenario: Group Login latency by company

- **WHEN** an operator groups `oteldemo.AuthService/Login` by `demo.auth.method` and `demo.company`
- **THEN** every successful or failed login for a known user has both attributes, and `demo.auth.result` shows the outcome

#### Scenario: Diagnosis query

- **WHEN** an investigator filters `CheckUserStatus` for `demo.auth.status_check.result = error` and groups by `parent.demo.company`
- **THEN** every company except Globex appears, each with `enforced = false` and durations near 10 s

### Requirement: Login attempts are audited while the audit flag is on

When the flagd flag `auth.login-audit-log` is on, the system SHALL insert one row per login attempt into the
`login_event` table (user id and company id when known, method, result, timestamp). The flag is enabled, boolean
(`on` = true, `off` = false), described as "Record login attempts in the auth.login_event table", defaults to `on`
and carries `schedulable: false`. A failure to write the row SHALL NOT fail the login: it is recorded on the span
and logged as a warning. The audit write is an observable extra database call per login, so turning the flag off
removes it.

#### Scenario: Audit on

- **WHEN** the flag is on and a login (successful or not) completes
- **THEN** one `login_event` row exists for it, with the result value, including `unknown_user` rows with no user or company

#### Scenario: Audit off

- **WHEN** the flag is off
- **THEN** no `login_event` rows are written and logins behave the same otherwise

### Requirement: Third parties appear only as remote dependencies in traces

A small stand-in service (`sso-mocks`) SHALL play both third parties, because the demo has no real ones and needs no
network access. It SHALL NOT emit traces, metrics or logs to the telemetry pipeline. Real third parties do not send
spans, so `auth`'s client spans have no matching server span and show as remote dependencies.

#### Scenario: Trace of an SSO login

- **WHEN** an SSO login is traced
- **THEN** the call to the identity provider appears only as a client span in `auth`

### Requirement: The identity provider accepts every subject within 20 to 60 ms

The stand-in SHALL serve HTTPS `POST sso.keystone-id.example/api/v1/tenants/{tenant}/assertions/verify`. For any
tenant it answers HTTP 200 with JSON `{"valid": true}` after a random delay of 20 to 60 ms. It never rejects.

#### Scenario: Verification

- **WHEN** `auth` posts a subject to the endpoint for any tenant id
- **THEN** it receives `{"valid": true}` in about 20 to 60 ms

### Requirement: Globex answers employee status quickly, with about 4% terminated

The stand-in SHALL serve HTTPS `GET sso-status.globex.example/v1/users/{id}`. After a random delay of 30 to 70 ms it
answers JSON `{"id": "<id>", "status": "<status>"}`. The status is `active` for about 96% of ids and `terminated`
for about 4% (roughly one in 25). The choice is a deterministic function of the user id, so the same users are
always terminated and the same id gives the same answer on every call and restart. Only Globex has a working status
host. Other tenants' status hostnames are not served.

#### Scenario: Stable terminated users

- **WHEN** the same Globex user id is asked about twice
- **THEN** both answers are identical

#### Scenario: About 4% of Globex logins denied

- **WHEN** many Globex SSO users log in while the status check is on for Globex
- **THEN** about 4% fail with result `user_not_current`

### Requirement: Third-party calls use trusted HTTPS

The stand-in SHALL serve TLS on `127.0.0.1:443`. Its certificate covers both hostnames and is signed by a demo
certificate authority that `auth` trusts. It answers `GET /healthz` with HTTP 200. It runs next to `auth`, shares its network, and the two hostnames resolve to loopback
for `auth`. It is not reachable from other services.

#### Scenario: Trusted TLS

- **WHEN** `auth` calls either hostname over HTTPS
- **THEN** certificate validation passes, with no verification disabled in the client

### Requirement: The login link is shown only while its flag is on

The header SHALL show a "Log in" link to `/login` to anonymous visitors only when the flagd flag
`frontend.login-link` is on. The flag is enabled, boolean (`on` = true, `off` = false), described as "Show the
corporate login link in the header", defaults to `on` and carries `schedulable: false`. The frontend evaluates it in
the browser. When off, no login entry appears but `/login` still works if visited.

#### Scenario: Flag off

- **WHEN** `frontend.login-link` is off and the visitor is not logged in
- **THEN** the header shows no login link

### Requirement: Visitors can sign in on `/login`

The frontend SHALL serve a page at `/login`, titled "Otel Demo - Log in", headed "Corporate account log in", with a
"Work email" field, a "Password" field, a "Sign in" button (password method) and a "Sign in with SSO" button. The SSO
button is disabled while the email is empty and sends an empty password with `method = "sso"`. Both buttons are
disabled while a request is in flight. A rejected login shows the server's error message in an alert area. On
success the user is taken to the home page.

#### Scenario: Wrong password from the load generator

- **WHEN** the visitor submits a wrong password
- **THEN** the page shows "invalid email or password" and stays on `/login`

#### Scenario: SSO user signs in

- **WHEN** a visitor enters an SSO company email and chooses "Sign in with SSO"
- **THEN** the login succeeds without a password and the visitor lands on the home page

### Requirement: Logged-in users see their company and name in the header

After a successful login the header SHALL show "`<Company name>` · `<Display name>`" and a "Log out" button instead of
the login link. Log out removes the corporate identity from the session but keeps the anonymous shopping session
(user id and currency). The corporate identity lasts for the browser tab's session, not across tabs or restarts.
The checkout form SHALL start with the work email of a logged-in user in the email field.

#### Scenario: Log out

- **WHEN** a logged-in user clicks "Log out"
- **THEN** the header returns to the anonymous state, and the cart and currency remain

### Requirement: Browser flag rules can target a company

The browser's feature flag evaluation context SHALL use the session user id as its targeting key and include the
session fields, including `company` and the corporate user id when a corporate user is logged in, so flag rules can
target a company.

#### Scenario: Targeting by company

- **WHEN** a browser flag rule matches on `company`
- **THEN** it applies only to sessions logged in to that company

### Requirement: `POST /api/login` signs in and maps failures to HTTP statuses

The frontend SHALL provide `POST /api/login` taking JSON `{ "email", "password", "method" }` (missing values are
empty, and `method` defaults to `password`), calling `AuthService.Login` (address from `AUTH_ADDR`), and answering:

- 200 with JSON `{ corporateUserId, company, companyName, email, displayName }`.
- When the RPC fails, JSON `{ "error": "<message from the auth service>" }` with status mapped from the gRPC code:
  `UNAUTHENTICATED` → 401, `PERMISSION_DENIED` → 403, `FAILED_PRECONDITION` → 409, `INVALID_ARGUMENT` → 400,
  `UNAVAILABLE` → 503. Any other failure (for example `INTERNAL`) is an unhandled error, which gives 500.
- 405 `{ "error": "Method not allowed" }` for other HTTP methods.

A rejected login that is mapped to 4xx/503 logs "Login rejected" at info level with `demo.auth.method` and
`rpc.grpc.status_code`. The frontend server span carries `demo.auth.method`. After success it also carries
`demo.company` and `demo.corporate_user.id`.

#### Scenario: Slow login seen from the frontend

- **WHEN** the auth service takes 10 seconds to answer a non-Globex SSO login
- **THEN** the `/api/login` request takes about 10 seconds and returns 200

### Requirement: Company and user on browser and frontend telemetry

While a corporate user is logged in, spans created in the browser SHALL carry `demo.corporate_user.id` and
`demo.company`, and requests the browser makes to the frontend API SHALL carry the same two values in W3C baggage.
The frontend server span for each API route request copies both values from baggage to span attributes. When nobody
is logged in, neither attribute is set (absent, not empty). Later spans in a tab that is already open gain the
attributes after login without a reload.

#### Scenario: Group shop traffic by company

- **WHEN** a logged-in user browses and adds to the cart
- **THEN** the browser and frontend server spans for those requests carry the user's `demo.company` and `demo.corporate_user.id`

#### Scenario: Anonymous shopper

- **WHEN** nobody has logged in
- **THEN** spans have no `demo.company` and no `demo.corporate_user.id`

### Requirement: The load generator logs in as the seeded corporate users

The load generator SHALL have a list of the seeded corporate users, each with `email`, `company`, `method`
(`password` or `sso`) and `password` (the demo password for password tenants, `null` for SSO). It SHALL match the
seeded database exactly: 1035 users in 40 companies.

#### Scenario: Users exist in the database

- **WHEN** a user is picked from the list
- **THEN** the email exists in the seeded database with the same company and method

### Requirement: Login traffic mix

Each plain-HTTP load generator user SHALL, as one of its weighted behaviors (weight 4, compared with 10 for browsing
a product, 3 for most others and 1 for index), post to `/api/login` with JSON `{email, password, method}`:

- **Tenant choice:** 35% of logins are for Globex (a random Globex user). The rest pick a random non-Globex company
  uniformly (not weighted by user count), then a random user of it.
- **Method:** the body uses the user's company method. SSO logins send `method = "sso"` and no password. Password
  logins send the user's password and `method = "password"`.
- **Failures:** 6% of password logins send the password with `!` appended, so they are rejected. 1% of all logins use
  a made-up address `former.employee<1-999>@<company domain>` that does not exist.

Expected mix: about 35% Globex SSO, about 38% non-Globex SSO, about 27% password. This gives the "about 40% of
logins are affected" in the story. Changing these shares changes the story's numbers. Login traffic is independent of
shopping: logged-in state is not reused for later requests.

#### Scenario: SSO share

- **WHEN** many logins are generated
- **THEN** non-Globex SSO logins are about 38% of the traffic, Globex logins about 35%, password logins about 27%

### Requirement: Login traffic is traced in its own root traces and rejected logins count as success

Each login SHALL run in its own new root trace with a span named `user_login` carrying `demo.company` and
`demo.auth.method`. The same trace continues into the frontend and the auth service. A response status below 500
counts as a success for load-generator statistics, because rejected logins (wrong password, unknown employee,
blocked account) are normal traffic. A 5xx counts as a failure. Because each load generator user waits for its
login, a login that takes 10 seconds reduces how often that user does anything else, so the login rate (and so
`demo.auth.logins`) drops during the incident.

#### Scenario: Rejected login

- **WHEN** the auth service answers 401 for a wrong password
- **THEN** the load generator records the request as a success

### Requirement: Login telemetry is defined in the telemetry registry

Every attribute and metric below SHALL be defined in the demo's telemetry registry, in the auth attribute and
metric definitions, under the `demo.` prefix (never `app.`), and declared by the services that emit them. No
semantic-convention name exists for them, except `session.id` and `user.id`, which are reused as they are.
The `demo.auth.result` definition SHALL list the eight result values given above as its examples.

| Name | Type | Meaning | Carried by |
| --- | --- | --- | --- |
| `demo.company` | string | company slug, for example `globex`, `dunder-paper` | Login span, `CheckUserStatus` through its parent, browser spans, baggage, frontend server spans, `user_login` span, `demo.auth.logins` |
| `demo.corporate_user.id` | string | corporate user id | same carriers as `demo.company` (except the metric) |
| `demo.auth.method` | string | `password` or `sso` | Login span, frontend login route span, `user_login` span, `demo.auth.logins` |
| `demo.auth.result` | string | login outcome | Login span, `demo.auth.logins` |
| `demo.auth.email_domain` | string | domain part of the login email | Login span |
| `demo.auth.idp` | string | identity provider, `keystone-id` | `VerifySSOAssertion` span |
| `demo.auth.idp_tenant` | string | company's tenant id at the provider | `VerifySSOAssertion` span |
| `demo.auth.hash_algorithm` | string | `bcrypt` | `VerifyPassword` span |
| `demo.auth.hash_cost` | int | password hash work factor, `10` | `VerifyPassword` span |
| `demo.auth.password_match` | boolean | submitted password matched | `VerifyPassword` span |
| `demo.auth.status_check.enforced` | boolean | a failed check blocks the login | `CheckUserStatus` span |
| `demo.auth.status_check.result` | string | `active`, `not_current`, `error` | `CheckUserStatus` span |
| `demo.auth.logins` | counter, `{login}` | login attempts, with required attributes `demo.company`, `demo.auth.method`, `demo.auth.result` | `auth` metrics |

The `auth` service declares all `demo.auth.*` attributes, `demo.company` and `demo.corporate_user.id`; the
`frontend` service declares `demo.company`, `demo.corporate_user.id` and `demo.auth.method`; the `load-generator`
service declares `demo.company` and `demo.auth.method`.

#### Scenario: Registry check

- **WHEN** the registry check runs
- **THEN** every name in the table resolves, with the type and examples above, for the services that emit it
