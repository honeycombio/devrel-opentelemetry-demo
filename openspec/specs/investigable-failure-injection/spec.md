# Investigable Failure Injection Specification

## Purpose

The demo breaks things on purpose, and the breakage has to behave like a real incident so that people and agents using Honeycomb must find the cause from the data. This spec covers the `paymentFailure` flag as the worked example, and the evidence a flag change leaves behind.

- **The failure looks real.** Declined charges fail like card issuer declines, with a plausible reason chosen at random. Nothing in the error text or span attributes announces a hidden cause such as a customer's loyalty level, so an investigator has to find the real pattern with tools such as BubbleUp.
- **The dial is recorded apart from the failing spans.** A flag's numeric value is published as its own metric, never as an attribute on the request spans the flag breaks. A span attribute such as "payment decline = 75%" would show up in BubbleUp on exactly the traces the flag breaks and give the answer away.
- **Changes leave evidence.** Each flag change writes one log line that the collector turns into a Honeycomb marker, so every graph shows a vertical line where the dial moved.
- **The flag system never causes failures.** A payment never fails because flagd is unavailable. flagd outages do not appear in checkout success rates.

## Apps affected

- `payment`: reads `paymentFailure` on every charge, injects issuer declines, and emits the `charge` span and the transaction metric. Falls back to defaults when the flag cannot be read.
- `flagd`: carries the flag `paymentFailure`.
- `flagd-ui`: edits flag definitions; emits the value metric and the change log line; renders the variant dropdown.
- `otel-collector`: matches the change log line by prefix and creates a Honeycomb marker from it.

## Requirements

### Requirement: paymentFailure is a safe-by-default dial

The flagd flag file SHALL define the flag `paymentFailure`: state `ENABLED`, description "Fail payment service charge requests n%", numeric variants `off` = 0, `10%` = 0.1, `25%` = 0.25, `50%` = 0.5, `75%` = 0.75, `90%` = 0.95, `100%` = 1, default variant `off`, no targeting. The flag is read only by the payment service. A fresh deployment has the flag at `off`, so no charge is declined until someone changes it.

#### Scenario: Fresh deployment

- **WHEN** the demo starts with the shipped flag file
- **THEN** `paymentFailure` is `off` and no charge is declined

### Requirement: Declined charges look like issuer declines

The payment service SHALL read the numeric flag `paymentFailure` (default `0`) at the start of every charge. When the value is above 0, the charge SHALL be declined with probability equal to the value (`0.25` declines about a quarter of charges, `1` declines all). A declined charge fails with an error whose message is `Payment declined by card issuer: <reason>`, where `<reason>` is chosen at random from `do_not_honor`, `issuer_unavailable`, `suspected_fraud`, `insufficient_funds`. The check happens before the card is validated, so whether a charge is declined does not depend on the card used.

The `charge` span of a declined charge SHALL have `demo.payment.declined = true` and `demo.payment.decline_reason = <reason>`, SHALL record the exception, SHALL have error status with the message, and SHALL have `error.type` set. Nothing in the message or the attributes SHALL hint at loyalty level or any other hidden cause. With the flag at `0`, or unreadable, no charge is declined.

#### Scenario: Flag at 100%

- **WHEN** `paymentFailure` is `1` and any card is charged
- **THEN** the charge fails with `Payment declined by card issuer: <reason>` and the span has `demo.payment.declined = true`, a `demo.payment.decline_reason` from the list, and error status

#### Scenario: Flag off

- **WHEN** `paymentFailure` is `0`
- **THEN** no span has `demo.payment.declined`

#### Scenario: Reason does not reveal the cause

- **WHEN** declined charges are grouped by `demo.payment.decline_reason` and by error message
- **THEN** the reasons are spread across the four values and no value correlates with a customer attribute

### Requirement: Charge spans carry the facts an investigator groups by

Every charge SHALL run in a span named `charge`. A charge that reaches card validation carries `demo.payment.card_type` (string; the network name from card validation, for example `visa`, `mastercard`, `amex`, `unknown`), `demo.payment.card_valid` (boolean) and `demo.user_context.loyalty_level` (string; a random pick from `platinum`, `gold`, `silver`, `bronze`). A successful charge also carries `demo.payment.charged` (boolean; `false` when the request's baggage has `synthetic_request=true`, otherwise `true`) and `demo.payment.transaction.id` (string; the transaction id the charge returns). Any failure marks the span with error status and the exception and sets `error.type`, and the span is always ended, including on validation failures.

#### Scenario: Synthetic checkout

- **WHEN** a valid card is charged with `synthetic_request=true` baggage
- **THEN** the span has `demo.payment.charged = false` and a `demo.payment.transaction.id`

#### Scenario: Real checkout

- **WHEN** a valid card is charged without that baggage
- **THEN** the span has `demo.payment.charged = true`

### Requirement: Successful charges are counted by currency

Each successful charge SHALL add 1 to the counter metric `demo.payment.transactions`, unit `{transaction}`, with the string attribute `demo.payment.currency` set to the currency code of the charge.

#### Scenario: Charge in EUR

- **WHEN** a charge in `EUR` succeeds
- **THEN** `demo.payment.transactions` increases by 1 with `demo.payment.currency = EUR`

### Requirement: A flag outage never fails a charge

The payment service SHALL connect to flagd once, when the process starts, and share that connection across all charges. Startup SHALL NOT wait for flagd: the service accepts and processes charges on flag defaults immediately and starts honoring flag values once flagd is reachable, without a restart. Reading a flag SHALL NOT disturb that connection. A replacement connection is built only if the feature flag SDK declares the current one irrecoverable, and then with a growing, jittered delay (from about 1 second up to a cap of 30 seconds). Transient disconnects are left to the connection's own reconnection. The connection is closed once, on shutdown.

Every flag read in payment SHALL return the caller's default value when the flag cannot be read for any reason (flagd down, not ready, error result, thrown error). The default for `paymentFailure` is `0`, meaning no injected failures. A flag read failure SHALL NOT set an error status on the span: the span records an event `feature_flag.evaluation_failed` with attributes `feature_flag.key`, `error.type` and `error.message`, plus the flag attributes of the next requirement with `feature_flag.result.reason = error`. A warning is logged.

#### Scenario: flagd unreachable

- **WHEN** flagd is unreachable and a valid card is charged
- **THEN** the charge succeeds, the span has no error status, and it carries the `feature_flag.evaluation_failed` event

#### Scenario: Fallback is not blanket approval

- **WHEN** flagd is unreachable and an invalid card is charged
- **THEN** the charge still fails with the card validity error

#### Scenario: flagd is slow to come up

- **WHEN** payment starts before flagd is reachable
- **THEN** it processes charges immediately on defaults, and honors flag values once flagd connects, without a restart

#### Scenario: Flag reads do not disrupt the service

- **WHEN** many charges each read `paymentFailure`
- **THEN** the flagd connection is the same throughout and no flag read causes a reconnect

### Requirement: Flag reads are recorded on the charge span

When a flag is read successfully the span SHALL carry `feature_flag.key`, `feature_flag.provider.name` (`flagd`), `feature_flag.result.value`, `feature_flag.result.variant` (when the provider returns one) and `feature_flag.result.reason` in lowercase (for example `targeting_match`, `static`). No error event is added.

#### Scenario: Resolved value used

- **WHEN** flagd resolves `paymentFailure` to `0.5`
- **THEN** the injected failure rate is 50% and the span has `feature_flag.result.value = 0.5`

### Requirement: Flag changes publish the value as a gauge, apart from spans

When a flag's default variant is changed, flagd-ui SHALL send one gauge data point named `feature_flag.value`, unit `1`, to the OTLP/HTTP metrics endpoint `<OTEL_EXPORTER_OTLP_ENDPOINT>/v1/metrics`. The data point SHALL carry the attributes `feature_flag.key` (the flag name) and `feature_flag.variant` (the new variant name), and its value SHALL be the number behind the new variant. The resource's `service.name` SHALL be the value of `OTEL_SERVICE_NAME`, or `flagd-ui` when that is unset. The instrumentation scope SHALL be named `flagd_ui.feature_flags`. A variant whose value is not a number (such as the value of a boolean flag) SHALL produce no data point.

A change counts when made through the dashboard, or through the advanced editor that replaces the whole flag file. The advanced editor SHALL compare the old and the new state and send a data point for every flag whose default variant differs.

The flag value SHALL be published only as this gauge. Changing a flag SHALL NOT cause its value to be added as an attribute on the spans of the services the flag affects.

#### Scenario: Setting paymentFailure to 75%

- **WHEN** a user sets `paymentFailure` to its `75%` variant in the dashboard
- **THEN** a gauge point `feature_flag.value = 0.75` is sent with `feature_flag.key = paymentFailure` and `feature_flag.variant = 75%`

#### Scenario: Boolean flag

- **WHEN** a user turns a boolean flag on
- **THEN** no `feature_flag.value` point is sent, but the change log line still appears

#### Scenario: Advanced editor changes two flags

- **WHEN** a user saves a flag file in the advanced editor in which two flags have a different default variant than before
- **THEN** one data point is sent for each of the two flags and none for the other flags

#### Scenario: Graphing a dial

- **WHEN** the metric `feature_flag.value` is queried and grouped by `feature_flag.key`
- **THEN** it shows the flag's value over time, and request spans carry no copy of that value

### Requirement: Sending the gauge never blocks a flag change

Sending the gauge SHALL NOT block or fail the flag change. When `OTEL_EXPORTER_OTLP_ENDPOINT` is not set, nothing SHALL be sent. When a send fails, flagd-ui SHALL log a warning and carry on.

#### Scenario: Collector unreachable

- **WHEN** a user changes a numeric flag and the metrics endpoint does not answer
- **THEN** the flag change is saved and applied, and flagd-ui logs a warning

### Requirement: Every flag change writes one marker-ready log line

On every change of a flag's default variant, flagd-ui SHALL log at info level to standard output exactly one line of the form `Flag changed: <flag> (<previous> → <new>) [<source>]`. `<source>` SHALL be `ui-dashboard` for a dashboard change and `ui-advanced` for an advanced editor change. A flag that is added shows an empty `<previous>`. A flag that is removed shows an empty `<new>`. A flag whose default variant is unchanged logs nothing. The prefix `Flag changed:` is a contract.

The collector SHALL match log lines by that prefix and create a Honeycomb marker from each one, so that a vertical line appears on every graph at the moment the flag moved.

#### Scenario: Dashboard change

- **WHEN** `frontendAllowsMastercard2Series` is switched from `off` to `on` in the dashboard
- **THEN** the line `Flag changed: frontendAllowsMastercard2Series (off → on) [ui-dashboard]` is written and a Honeycomb marker is created from it

#### Scenario: Advanced editor saves without changes

- **WHEN** a user saves the advanced editor without changing any default variant
- **THEN** no `Flag changed:` line is written

#### Scenario: Flag added in the advanced editor

- **WHEN** a user adds a flag with default variant `on` in the advanced editor
- **THEN** the line `Flag changed: <flag> ( → on) [ui-advanced]` is written

### Requirement: Variant dropdown is ordered and readable

The flag dashboard's variant dropdown SHALL list a flag's variants sorted by their underlying value, not in the order they appear in the flag file. Percentage flags SHALL list `off`, then ascending percentages up to `100%`. Boolean flags SHALL list `off`, then `on`. The text in the dashboard's dropdowns SHALL be black so that it is readable on the light dropdown background.

#### Scenario: paymentFailure dropdown

- **WHEN** the dashboard shows the variants of `paymentFailure`
- **THEN** they appear in ascending value order and start with `off`, and the option text is black

### Requirement: Telemetry names are defined in the registry

The attributes `demo.payment.declined` (boolean), `demo.payment.decline_reason` (string), `demo.payment.charged`, `demo.payment.card_type`, `demo.payment.card_valid`, `demo.payment.transaction.id`, `demo.payment.currency` and `demo.user_context.loyalty_level`, and the metric `demo.payment.transactions` (counter, `{transaction}`, carrying `demo.payment.currency`), SHALL be defined in the demo's telemetry registry under the `demo.` prefix (never `app.`), each with type, brief and note, and declared as emitted by the payment service. The metric `feature_flag.value` (gauge, unit `1`) and the attributes `feature_flag.key` and `feature_flag.variant` SHALL be defined in the registry too, reusing the semantic-convention names exactly and declared as emitted by flagd-ui. The `feature_flag.*` and `error.type` span attributes the payment service uses are semantic-convention names and SHALL be used as they are. No name SHALL start with `app.`.

#### Scenario: Registry check

- **WHEN** the registry check runs
- **THEN** it passes and finds a definition for each name listed above
