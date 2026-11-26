# Mastercard 2-Series Story Specification

## Purpose

This use case gives people and agents using Honeycomb a checkout failure to investigate whose cause is a real bug in
a dependency, exposed by a "fix" elsewhere. Once the feature flag `frontendAllowsMastercard2Series` is turned on,
about 22% of load-generator checkouts fail with `Credit card info is invalid.` The investigator looks at
`charge` spans in payment, at `PlaceOrder` spans in checkout and at the proxy's root spans, and finds that the
client recognised the card as a Mastercard (`demo.payment.strategy = CC_MASTERCARD`) while payment did not
(`demo.payment.card_type = unknown`). The checkout and frontend availability SLOs burn budget while the flag is on.

Mastercard 2-series cards (numbers starting 2221-2720, issued since 2017) are real Mastercards. The client (browser
or load generator) says which payment method the customer is using; the payment service independently classifies
the card and rejects 2-series cards as invalid. While the two views agree nothing is wrong: the flag simulates the
frontend being fixed to let these cards through, and the planted bug in payment's card recognition then shows.
Failures group cleanly on the pair `demo.payment.strategy` and `demo.payment.card_type`. The flag name may hint at
the cause, because a frontend fix is a believable thing to have shipped.

The payment service accepts cards of every recognised network, so the only card failures in the data are the
ones planted on purpose.

## Apps affected

- `payment`: accepts every recognised network and deliberately does not recognise the 2-series; its `charge`
  span is where the verdict is recorded.
- `frontend`: names the card network as the customer types and sends it as the payment strategy.
- `checkout`: records the client's payment strategy on its `PlaceOrder` span.
- `load-generator`: plays the browser and sends the same field with a mix of card networks, gated by the flag.
- `flagd`: carries the flag `frontendAllowsMastercard2Series`.

## Requirements

### Requirement: Every recognised network is accepted

The payment service SHALL charge any card that its card validation recognises as a valid card of any network
(for example Visa, Mastercard, American Express and Discover), provided the number passes validation and the
card has not expired. It SHALL NOT reject a valid card because of its network.

#### Scenario: American Express

- **WHEN** a Luhn-valid American Express number with a future expiry is charged
- **THEN** the charge succeeds and the `charge` span has `demo.payment.card_type = amex`

#### Scenario: Visa and Mastercard

- **WHEN** a valid Visa or 5-series Mastercard with a future expiry is charged
- **THEN** the charge succeeds

### Requirement: Invalid and expired cards are rejected

The payment service SHALL reject a card that fails validation with the error message
`Credit card info is invalid.`, and SHALL reject a card whose expiry month and year are before the current
month with the error message `The credit card (ending <last four digits>) expired on <month>/<year>.`.
The `charge` span SHALL carry `demo.payment.card_type` (string; the network name that validation assigns, for
example `visa`, `mastercard`, `amex`, `discover`, `unknown`) and `demo.payment.card_valid` (boolean) before the
card is rejected, and SHALL be marked as an error when it is.

#### Scenario: Bad number

- **WHEN** a number that fails validation is charged
- **THEN** the charge fails with `Credit card info is invalid.` and the span has `demo.payment.card_valid = false` and error status

#### Scenario: Expired card

- **WHEN** a valid number with last four digits `4444` and an expiry in a past month is charged
- **THEN** the charge fails with `The credit card (ending 4444) expired on <month>/<year>.`

### Requirement: Mastercard 2-series is deliberately not recognised

The payment service SHALL NOT recognise Mastercard 2-series numbers (BIN range 2221-2720). Such a card,
although Luhn-valid and a real Mastercard, SHALL be given the network name `unknown`, be treated as invalid,
and be rejected with `Credit card info is invalid.`. This is the planted bug the story depends on.

#### Scenario: 2-series card

- **WHEN** the card `2223 0031 2200 3222` is charged
- **THEN** the charge fails with `Credit card info is invalid.`, with `demo.payment.card_type = unknown` and `demo.payment.card_valid = false` on the `charge` span, and the span is marked as an error

### Requirement: Orders report the payment strategy the client chose

The shared protocol definition SHALL define an enum `PaymentStrategy` with values
`PAYMENT_STRATEGY_UNSPECIFIED = 0`, `CC_VISA = 1`, `CC_MASTERCARD = 2`, `CC_AMEX = 3`, `CC_DISCOVER = 4`,
`CC_OTHER = 5`, and `PlaceOrderRequest` SHALL have the field `PaymentStrategy payment_strategy = 7`. The
field is optional: a client that omits it is treated as `PAYMENT_STRATEGY_UNSPECIFIED` and the order still
proceeds. The browser SHALL use the same numeric values.

#### Scenario: Client omits the field

- **WHEN** a client sends an order without a payment strategy
- **THEN** checkout treats it as `PAYMENT_STRATEGY_UNSPECIFIED` and the order proceeds

### Requirement: The payment strategy comes from the client's reading of the card number

The strategy SHALL be decided by the client from the card number and sent in the order request. Neither
checkout nor payment derives it from the card. The mapping SHALL be: numbers starting 51-55 or in the range
2221-2720 are `CC_MASTERCARD`; numbers starting 4 are `CC_VISA`; 34 or 37 are `CC_AMEX`; 6011, 65 or 644-649
are `CC_DISCOVER`; any other non-empty number is `CC_OTHER`; an empty number is `PAYMENT_STRATEGY_UNSPECIFIED`.

#### Scenario: Browser checkout with a 2-series card

- **WHEN** the customer enters `2223 0031 2200 3222` in the checkout form and places the order
- **THEN** the order request carries `CC_MASTERCARD`, and payment rejects the card as invalid

### Requirement: Customers see the detected card network while typing

The frontend checkout form SHALL show the network name (`Visa`, `Mastercard`, `American Express`,
`Discover`) under the card number field, updating as the customer types, and nothing for other or empty
numbers. The browser's detection recognises the Mastercard 2-series even though payment does not; that
asymmetry is the story. The browser SHALL NOT use payment's card validation for this.

#### Scenario: Typing a card

- **WHEN** the customer types a number starting `55`
- **THEN** the text `Mastercard` appears under the field

### Requirement: PlaceOrder spans show the strategy the client reported

The checkout service SHALL set the string span attribute `demo.payment.strategy` on its
`oteldemo.CheckoutService/PlaceOrder` server span to the enum name from the request (for example
`CC_MASTERCARD`; `PAYMENT_STRATEGY_UNSPECIFIED` when absent). The attribute means the payment method the
client reports, not derived from the card number, so it can disagree with `demo.payment.card_type` on
payment's `charge` span. The checkout SLOs are measured on the `PlaceOrder` span.

#### Scenario: Failed 2-series checkout

- **WHEN** a 2-series card checkout fails
- **THEN** the `PlaceOrder` span has `demo.payment.strategy = CC_MASTERCARD` and the `charge` span has `demo.payment.card_type = unknown`, so failures group cleanly on that pair

### Requirement: The flag decides whether 2-series cards are sent

The flagd flag file SHALL define the flag `frontendAllowsMastercard2Series`: state `ENABLED`, numeric variants
`on` = 1 and `off` = 0, default variant `off`, no targeting. It simulates a frontend fix that lets 2-series
cards through to checkout. Its variants SHALL be numeric, not boolean, because the load generator evaluates
it as an integer and treats a value of 0 or less as off. The flag is read only by the load generator.

#### Scenario: Fresh deployment

- **WHEN** the demo starts with the shipped flag file
- **THEN** `frontendAllowsMastercard2Series` is `off` and no 2-series card is sent

#### Scenario: Integer read

- **WHEN** the load generator reads the flag while the `on` variant is selected
- **THEN** it gets a value above 0

### Requirement: Load generator card mix

Each load generator checkout SHALL use a freshly generated Luhn-valid card number from a random network
chosen with these weights, prefixes and lengths, and SHALL send the numeric value of the matching
`paymentStrategy` in its request to the frontend's checkout route, playing the part of the browser:

| Network | Weight | Prefixes | Length | `paymentStrategy` sent |
| --- | --- | --- | --- | --- |
| Mastercard (5-series) | 55 | 51, 52, 53, 54, 55 | 16 | `CC_MASTERCARD` (2) |
| Mastercard 2-series | 22 | 2221, 2300, 2500, 2720 | 16 | `CC_MASTERCARD` (2) |
| Visa | 10 | 42, 43, 46 | 16 | `CC_VISA` (1) |
| American Express | 8 | 34, 37 | 15 | `CC_AMEX` (3) |
| Discover | 5 | 6011 | 16 | `CC_DISCOVER` (4) |

The rest of each number is random with a correct check digit. Prefixes are chosen so that payment's card
validation names the intended network (`visa`, `mastercard`, `amex`, `discover`); ranges it would type
differently (a few Visa ranges, a Discover range) are not used.

#### Scenario: Card mix

- **WHEN** many checkouts run with the 2-series flag on
- **THEN** about 55% are 5-series Mastercard, 22% 2-series Mastercard, 10% Visa, 8% Amex and 5% Discover, all Luhn-valid

### Requirement: Turning the flag on makes about 22% of load-generator checkouts fail

Before each card is generated the load generator SHALL read `frontendAllowsMastercard2Series` as an integer
from flagd's OFREP HTTP endpoint. While the value is 0
or less, or the flag cannot be read, the 2-series network SHALL be left out of the draw, the other weights
apply, and no 2-series card is sent. While the value is above 0, 2-series cards are drawn with weight 22 of a
total of 100, and every one is rejected by payment, so about 22% of load-generator checkouts fail with
`Credit card info is invalid.`. The flag is re-read for every checkout, so a change takes effect within
seconds.

#### Scenario: Flag on

- **WHEN** the flag is turned on
- **THEN** within seconds `PlaceOrder` spans with `demo.payment.strategy = CC_MASTERCARD` start failing at about the 2-series share, and the frontend-proxy root spans of those traces return status 500

#### Scenario: Flag off

- **WHEN** the flag is turned off
- **THEN** new 2-series cards stop at once and the failures stop within seconds

### Requirement: Payment telemetry names are defined in the registry

The attributes `demo.payment.strategy`, `demo.payment.card_type` and `demo.payment.card_valid` SHALL be defined
in the demo's telemetry registry under the `demo.` prefix (never `app.`), with type, brief and note, and the
registry check SHALL pass with them present. `demo.payment.strategy` SHALL be declared as emitted by checkout,
and `demo.payment.card_type` and `demo.payment.card_valid` as emitted by payment.

#### Scenario: Registry check

- **WHEN** the registry check runs
- **THEN** it passes with these definitions present
