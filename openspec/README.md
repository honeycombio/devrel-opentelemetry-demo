# Intent specs

This folder describes what the demo does, as [OpenSpec](https://github.com/Fission-AI/OpenSpec)-style
specifications. Each spec states the end state of one feature or demo story: the behavior, and the exact
contracts that dashboards, stories and other services depend on.

The specs are written so that an agent can rebuild the behavior on top of a newer
[open-telemetry/opentelemetry-demo](https://github.com/open-telemetry/opentelemetry-demo). We do not
keep merges from upstream clean. We take upstream's code, then re-implement each spec on top of it.

Deployment and local-development concerns (Helm values, skaffold, `./run`, orb setup, CI, collector
configuration) are out of scope. They are not application behavior.

## Layout

```text
openspec/
  README.md                    this file: conventions and the index
  specs/<capability>/spec.md   one spec per use case
```

A capability is one use case: the reason a set of changes exists. Find it by asking what the change is
for, who looks at the data (people and agents in Honeycomb, demo operators), and what they do with it.
Several services are often changed for one use case. The AI support agent, for example, needed persisted
orders, refunds, a shipping status lookup, new routes, flags, a Kafka topic and a collector pipeline.
That is one spec, not one per service. A spec is never "a service"; the services that take part appear
under "Apps affected" only.

## Spec format

```markdown
# <Capability> Specification

## Purpose
Why the demo has this: the story or value, and what a viewer sees in Honeycomb.

## Apps affected
- `<service>`: its role in this feature.

## Requirements

### Requirement: <short name>
The <service|system> SHALL <observable behavior>.

#### Scenario: <name>
- **WHEN** <situation>
- **THEN** <observable outcome>
```

## Writing rules

- **End state only.** Say what the demo does, in the present tense. Do not say what it was, what upstream
  does, what was added, replaced or renamed, or why a merge needs care. A reader cannot tell what the
  code looked like before.
- **Use case first.** The Purpose says what the demo is for and what a viewer sees in Honeycomb. Requirement
  titles state outcomes visible in telemetry or in the demo ("Declines look like real issuer declines"),
  never component duties ("Payment registers one flag provider"). Implementation mechanics (idempotent
  writes, indexes, how a client is registered, tests) appear only when they produce a visible outcome,
  phrased as that outcome.
- **Self-contained.** A spec never refers to another spec. Deleting any one spec leaves every other spec
  complete and implementable. When a use case relies on an interface another use case provides, state the
  interface in your own words. Repeating an exact contract in two specs is fine.
- **Everything the use case needs lives in its spec.** That includes its feature flags (exact name,
  variants, default, targeting), every telemetry attribute and metric (exact name, type, unit, meaning,
  where it appears), seeded data, the load generator traffic that drives the story, routes, RPCs and
  topics. There is no flag catalogue, traffic spec or attribute list that covers several features.
- **Intent and behavior, not code.** No file paths, function, class or library names. Service names, flag
  names, attribute names, routes, RPC names and topic names are contracts and are stated exactly.
- **Dashboards live outside this repo.** Honeycomb boards, SLOs, triggers and demo stories key off exact
  names, so any name a spec lists is a contract.
- **Telemetry names** are defined in the telemetry registry first, with the `demo.` prefix (never
  `app.`), as described in the root `AGENTS.md`.
- Use `SHALL` or `MUST` in every requirement and give every requirement at least one scenario. Do not
  repeat a statement. Write open questions and known defects in the pull request, not in the spec.

## Using the specs

For each spec, check each requirement against the code. Where the code already satisfies it, change
nothing. Where it does not, implement the requirement using the code's current structure and
conventions. Run the scenarios, and compare emitted attribute and metric names with the previous release.

## Keeping the specs current

Any change to application behavior must update the matching spec in the same pull request. See the root
`AGENTS.md`.

## Index

The index is maintained by hand. Add a line when you add a spec.

- [`slow-login`](specs/slow-login/spec.md): The "Slow login (Canvas Connectors)" incident: a login slowdown an investigator traces back to a flag cleanup, with corporate accounts, SSO, mock third parties, the UI and the traffic that makes it visible.
- [`mastercard-2-series`](specs/mastercard-2-series/spec.md): A checkout failure caused by a real dependency bug that a frontend "fix" exposes: all card networks accepted, payment strategy, card mix and flag gate.
- [`ai-support-agent`](specs/ai-support-agent/spec.md): A customer-support AI agent over real orders: persisted orders, lookup, refunds, shipping status, the chat agents, their failure and cost stories, and LLM evaluation of answers.
- [`frontend-real-user-monitoring`](specs/frontend-real-user-monitoring/spec.md): A storefront that shows Honeycomb Frontend Observability: web vitals, per-tab sessions, errors, the Slowville slow checkout, and browser traffic linked to backend traces.
- [`error-investigation`](specs/error-investigation/spec.md): Errors investigated through wide, trace-correlated logs: the cart failure flag, frontend API route logs, Kafka trouble at checkout, and the error customer.
- [`cart-n-plus-one`](specs/cart-n-plus-one/spec.md): One database call per cart item behind `cartservice.add-db-call`, visible as a trace waterfall.
- [`investigable-failure-injection`](specs/investigable-failure-injection/spec.md): Flag-driven failures that behave like real incidents: realistic payment declines, flag values kept off failing spans, flag changes leaving evidence.
- [`checkout-tax-defect`](specs/checkout-tax-defect/spec.md): A zero-quantity order line crashes the tax calculation.
- [`baseline-traffic`](specs/baseline-traffic/spec.md): Background traffic that looks like real edge traffic and is identifiable as synthetic.
