# Does upstream/main have our payment/flagd problem?

Investigated 2026-09-09, against `upstream/main` at `fcedca78`, as a follow-up to
our commit `915ce27a` ("payment: register one feature flag provider at startup,
never fail a charge on it").

**Short answer: partly. Our worst symptom was self-inflicted; a smaller, real bug
is upstream and worth a PR.**

## What upstream actually does

`upstream/main:src/payment/charge.js`:

```js
const flagProvider = new FlagdProvider();          // module scope, ONE instance
...
module.exports.charge = async request => {
  const span = tracer.startSpan('charge');
  try {
    ...
    await OpenFeature.setProviderAndWait(flagProvider);   // on EVERY request
    const numberVariant = await OpenFeature.getClient().getNumberValue("paymentFailure", 0);
```

Upstream has no `refund.js`. Payment is the **only** upstream service that touches
the provider on the request path — `src/ad` (Java) and `src/fraud-detection`
(Kotlin) both `setProvider` at startup, and `src/frontend/pages/_app.tsx` does it
once on mount.

## Which of our four problems upstream has

| Our problem | Upstream? |
|---|---|
| Provider thrash / `onClose()` killing a live gRPC channel | **No** |
| Reconnect loop being destroyed | **No** |
| Concurrency race on a NOT_READY provider | **No** |
| flagd down ⇒ checkout down | **Yes** |

### The two "no"s: the pipe-closed storm was ours, not upstream's

`OpenFeatureAPI.setAwaitableProvider` (`@openfeature/core`) early-returns when the
*same instance* is already installed:

```js
const oldProvider = this.getProviderForClient(domain);
if (oldProvider === provider) {
  this._logger.debug("Provider is already set, ignoring setProvider call");
  return;
}
```

With upstream's single module-scope instance, the per-request call is a no-op after
the first success — pointless, but harmless. Our fork's flood of pipe-closed errors
came from **our own** `refund.js` constructing a *second* `FlagdProvider` and
alternating with `charge.js` in OpenFeature's single default-provider slot, so each
swap called `onClose()` on the other module's live channel. That is a devrel-fork
regression, not an upstream defect.

### The "no" on the concurrency race

`Client#evaluate` catches `shortCircuitIfNotReady()` internally and returns
`getErrorEvaluationDetails` — i.e. **the caller's default value**. So
`getNumberValue` does *not* throw on NOT_READY/ERROR/FATAL. (Worth noting: the
`ProviderNotReadyError` framing in our commit message overstates this; the throw we
actually hit was `setProviderAndWait` rejecting, not the flag read.)

### The real upstream bug: the first charge fails if flagd isn't up

`setProviderAndWait` **rejects** when `initialize()` fails. Upstream calls it inside
`charge()`'s `try`, so the rejection becomes `recordException` + `SpanStatusCode.ERROR`
+ a rethrow, and `index.js`'s `chargeServiceHandler` turns that into `callback(err)`
— a gRPC error back to checkout. A flag-service hiccup fails a real payment.

Reproduced with upstream's own dependency versions (`@openfeature/server-sdk@1.23.0`,
`@openfeature/flagd-provider@0.16.1`), flagd unreachable:

```
request 1: THREW Error: Failed to connect before the deadline
request 2: OK, paymentFailure=0
request 3: OK, paymentFailure=0
```

Concurrent first-requests behave the same way — `setAwaitableProvider` runs to
completion synchronously, so only the very first caller awaits `initialize()` and
only it rejects:

```
concurrent request 1: REJECTED Failed to connect before the deadline
concurrent request 2..5: OK 0
```

**Blast radius is bounded.** After that failure the provider stays installed, every
later `setProviderAndWait` early-returns, evaluations fall back to defaults without
throwing, and the flagd provider's own reconnect loop revives it. Verified by
starting flagd *late* (wall-clock stamps, flagd container started at +12s):

```
[+0.5s]  first charge: REJECTED (Failed to connect before the deadline) status=ERROR
[+9.7s]  status=ERROR  paymentFailure=0
[+12s]   >>> starting flagd container on :8013
[+14.7s] status=READY  paymentFailure=0.75
```

So: exactly one failed charge per payment-process lifetime, in the window before
flagd is reachable. Not a storm — but a demo that teaches "register your flag
provider on the request path, and let the flag service fail your payments."

**It is reachable in practice.** Upstream's `compose.yaml` gives `payment` no
`depends_on: flagd` (only `FLAGD_HOST`/`FLAGD_PORT` env), and on Kubernetes pod
start order is arbitrary. No matching upstream issue found via `gh search issues`.

## Proposed upstream PR (much smaller than our fork's fix)

Because `evaluate()` already falls back to the caller's default, upstream needs no
wrapper module, no span events, no FATAL handling — just move registration to
startup and stop letting it reject into a charge.

`src/payment/index.js` — add:

```js
const { OpenFeature } = require('@openfeature/server-sdk');
const { FlagdProvider } = require('@openfeature/flagd-provider');

// Register the feature flag provider once, at startup, off the request path.
// Don't block startup on flagd: if it isn't reachable yet, the provider
// reconnects on its own and flag reads fall back to their defaults.
OpenFeature.setProviderAndWait(new FlagdProvider()).catch(err => {
  logger.warn({ err }, 'feature flag provider not ready; using flag defaults until it reconnects');
});
```

`src/payment/charge.js` — delete the module-scope `new FlagdProvider()` and the
`await OpenFeature.setProviderAndWait(flagProvider)` line; hoist the client:

```js
const flagClient = OpenFeature.getClient();
...
const numberVariant = await flagClient.getNumberValue('paymentFailure', 0);
```

Optionally add `OpenFeature.close()` to `closeGracefully`.

Verified with flagd down for the entire run — no charge fails, flags read as their
defaults, and per the recovery test above the provider self-heals when flagd appears:

```
charge 1: OK, paymentFailure=0
charge 2: OK, paymentFailure=0
startup: provider not ready (Failed to connect before the deadline); flag reads will use defaults
charge 3: OK, paymentFailure=0
```

This also makes payment consistent with `ad` and `fraud-detection`, which is a
framing the upstream maintainers are likely to accept.

## Follow-up for our fork

Our `src/payment/featureFlags.js` is the right shape and does strictly more than the
upstream proposal needs (shared by `charge.js` + `refund.js`, span events on
evaluation failure, rebuild on FATAL). Keep it. If we push the minimal fix upstream,
the two will not conflict — ours supersedes it.

Repro scripts used for this analysis were throwaway (job tmp dir, not committed);
they are ~20 lines each and reconstructable from the snippets above.
