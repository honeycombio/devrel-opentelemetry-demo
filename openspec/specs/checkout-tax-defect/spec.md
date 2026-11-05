# Checkout Tax Defect Specification

## Purpose

This use case gives people and agents using Honeycomb a reproducible checkout crash to investigate. Checkout adds a
10% tax to each order line, and the tax calculation divides by the line quantity, so an order with a line of
quantity zero fails. The investigator starts from a failed `PlaceOrder` call that returns a gRPC `Internal` error,
and finds in the trace an error `calculateTax` span for the product and quantity involved, with an exception event
and a stack trace pointing at the division by zero, and an error log with the same product id and quantity. The
defect is always on, needs no feature flag, and stays in the demo. Around the defect, checkout stays up when a
handler crashes, returns proper gRPC errors, and never ignores a failed money sum. A shipping-quote failure also
leaves its status and response body in the trace.

## Apps affected

- `checkout`: order preparation, tax, order total, panic recovery and the shipping quote request.
- `shipping`: its quote endpoint (`POST /get-quote`) rejects lines with quantity 0, so it only receives lines with a quantity above 0.

## Requirements

### Requirement: Orders include a 10% tax per line

The order total that `PlaceOrder` returns and charges SHALL be the sum of the shipping cost converted to the shopper's currency, each line's unit price times its quantity, and a tax for each line at a rate of 10%, all in the shopper's currency. The tax for a line is computed from the line's unit price and quantity. The tax is not itemised in the order response. Rounding, and the exact tax for lines with a quantity above 1, are not fixed.

#### Scenario: Single item order

- **WHEN** a shopper orders 1 item priced 100.00 in their currency with free shipping
- **THEN** the total charged is about 110.00

### Requirement: Each line's tax calculation is a span that records its failure

While preparing an order, checkout SHALL start a span named `calculateTax` for each order line, carrying `demo.product.id` (string, the product of the line) and `demo.product.quantity` (int, the quantity of the line). If the tax calculation fails for a line, that span SHALL have error status with the failure message, an `exception` event with `exception.type`, `exception.message` and `exception.stacktrace`, and an error log `tax calculation failed` carrying `error`, `product_id` and `quantity`. Order preparation SHALL then continue with the next line.

#### Scenario: Line with quantity 0

- **WHEN** an order contains a line with quantity 0
- **THEN** a `calculateTax` span for that product has error status and an `exception` event for an integer division by zero, and an error log carries that product id and quantity 0

### Requirement: A zero-quantity line fails the order cleanly

The tax calculation MUST fail with a division by zero for a line with quantity 0. This is the story's intended defect and SHALL remain reproducible: checkout SHALL NOT skip, special-case or default zero-quantity lines in the tax calculation. The failure while computing the order total SHALL be returned as gRPC `Internal` with the message `internal error: <reason>`; the checkout process SHALL stay up. The caught failure SHALL set error status `panic recovered` on the current span, add an `exception` event with type, message and stack trace, and write an error log `recovered from panic in gRPC handler` with the method name, the error and the stack trace. The order SHALL NOT be charged.

#### Scenario: Placing an order with quantity 0

- **WHEN** a client places an order whose cart has a line with quantity 0
- **THEN** the call returns gRPC `Internal` with `internal error:` followed by the division-by-zero reason, checkout keeps serving other calls, the trace shows an error span with a stack trace, and no payment is attempted

### Requirement: Money arithmetic errors fail the order cleanly

If adding the shipping cost, a line cost or a line tax to the order total produces an invalid money sum (for example mixed currencies), `PlaceOrder` SHALL write an error log naming the failed step with the error, set error status `invalid money calculation` on its span, record the error on the span, and return gRPC `Internal` with a message starting `failed to calculate order total`. It SHALL NOT crash and SHALL NOT continue to charging.

#### Scenario: Invalid money sum

- **WHEN** a money addition fails during `PlaceOrder`
- **THEN** the order is rejected with `Internal` and the message `failed to calculate order total: ...`, and the span shows the error

### Requirement: Shipping quotes leave out zero-quantity lines

Checkout SHALL leave lines with quantity 0 out of the shipping quote request, because the shipping service rejects them.

#### Scenario: Cart with a zero-quantity line

- **WHEN** an order has lines with quantities 2 and 0
- **THEN** the quote request body lists only the line with quantity 2

### Requirement: Shipping quote failures record status and body

When the shipping service answers the quote request with any status other than 200, checkout SHALL fail the order. The error SHALL include both the numeric status code and the response body. Checkout SHALL put the response body in the span attribute `shipping.error.response` (string) on the span that is active during the quote request, which is the order-preparation span. `PlaceOrder` SHALL return gRPC `Internal` whose message contains that error, and the order SHALL NOT be charged.

#### Scenario: Shipping quote error

- **WHEN** the shipping service answers 500 with the body `quote failed`
- **THEN** the order fails with an error containing `500` and `quote failed`, and the order-preparation span has `shipping.error.response` = `quote failed`

### Requirement: Telemetry names are in the registry

Every custom attribute this feature names (`demo.product.id`, `demo.product.quantity`) SHALL be defined in the demo's telemetry registry under the `demo.` prefix, never `app.`, and declared by the `checkout` service. Semantic-convention names (`exception.type`, `exception.message`, `exception.stacktrace`) are reused as they are. The attribute `shipping.error.response` keeps exactly that name and SHALL also be defined in the registry and declared by `checkout`.

#### Scenario: Registry check

- **WHEN** the registry check runs
- **THEN** `demo.product.id`, `demo.product.quantity` and `shipping.error.response` are defined and declared by `checkout`
