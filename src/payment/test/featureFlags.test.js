// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

// The point of these tests: a payment must succeed even when the feature flag
// backend does not. Run with `npm test` from src/payment.

const test = require('node:test');
const assert = require('node:assert');

const { OpenFeature } = require('@openfeature/server-sdk');

const flags = require('../featureFlags');
const { charge } = require('../charge');
const { refund } = require('../refund');

/** A span stand-in that records what instrumentation did to it. */
function fakeSpan() {
  return {
    attributes: {},
    events: [],
    status: undefined,
    ended: false,
    setAttribute(k, v) { this.attributes[k] = v; },
    setAttributes(attrs) { Object.assign(this.attributes, attrs); },
    addEvent(name, attributes) { this.events.push({ name, attributes }); },
    setStatus(status) { this.status = status; },
    recordException() {},
    end() { this.ended = true; },
  };
}

/** A provider that resolves every number flag to one fixed value. */
function workingProvider(value) {
  return {
    metadata: { name: 'working-test-provider' },
    runsOn: 'server',
    initialize: async () => {},
    onClose: async () => {},
    resolveNumberEvaluation: async () => ({ value, variant: 'test', reason: 'TARGETING_MATCH' }),
    resolveBooleanEvaluation: async () => { throw new Error('not used'); },
    resolveStringEvaluation: async () => { throw new Error('not used'); },
    resolveObjectEvaluation: async () => { throw new Error('not used'); },
  };
}

/** A provider whose initialize() rejects, the way flagd does when it is down. */
function unreachableProvider() {
  return {
    metadata: { name: 'unreachable-test-provider' },
    runsOn: 'server',
    initialize: async () => { throw new Error('connect ECONNREFUSED'); },
    onClose: async () => {},
    resolveNumberEvaluation: async () => { throw new Error('no connection'); },
    resolveBooleanEvaluation: async () => { throw new Error('no connection'); },
    resolveStringEvaluation: async () => { throw new Error('no connection'); },
    resolveObjectEvaluation: async () => { throw new Error('no connection'); },
  };
}

const validCard = {
  creditCardNumber: '4432-8015-6152-0454',
  creditCardExpirationYear: new Date().getFullYear() + 2,
  creditCardExpirationMonth: 1,
};

const validRequest = {
  creditCard: validCard,
  amount: { units: 42, nanos: 0, currencyCode: 'USD' },
};

/**
 * Register a provider that cannot reach its backend. Note that we never call
 * flags.start() here: the module's client resolves whatever provider is
 * registered at evaluation time, which is what lets the real service serve
 * traffic before flagd has connected.
 */
async function useUnreachableProvider() {
  await OpenFeature.setProviderAndWait(unreachableProvider()).catch(() => {});
}

test('getNumber falls back to the default when the flag cannot be read', async () => {
  await useUnreachableProvider();

  const span = fakeSpan();
  const value = await flags.getNumber('paymentFailure', 0.25, span);

  assert.strictEqual(value, 0.25, 'should return the caller default');
  assert.strictEqual(span.attributes['feature_flag.key'], 'paymentFailure');
  assert.strictEqual(span.attributes['feature_flag.result.reason'], 'error');

  const failureEvent = span.events.find(e => e.name === 'feature_flag.evaluation_failed');
  assert.ok(failureEvent, 'should emit an error span event');
  assert.strictEqual(failureEvent.attributes['feature_flag.key'], 'paymentFailure');
  assert.ok(failureEvent.attributes['error.type'], 'should say what went wrong');

  assert.strictEqual(span.status, undefined, 'a flag failure must not mark the span as failed');
});

test('charge succeeds when the feature flag backend is unreachable', async () => {
  await useUnreachableProvider();

  const result = await charge(validRequest);

  assert.ok(result.transactionId, 'the payment must still be processed');
});

test('charge still rejects a genuinely bad card', async () => {
  await useUnreachableProvider();

  await assert.rejects(
    () => charge({ ...validRequest, creditCard: { ...validCard, creditCardNumber: '1234-5678-9012-3456' } }),
    /invalid/i,
    'flag fallback must not turn into blanket approval'
  );
});

// The original bug: charge and refund each registered their own provider on
// every request, so the two of them thrashed the single default provider slot.
test('evaluating flags never swaps the provider', async () => {
  await useUnreachableProvider();
  const first = OpenFeature.getProvider();

  await flags.getNumber('paymentFailure', 0, fakeSpan());
  await flags.getNumber('paymentServiceRefundFailure', 0, fakeSpan());

  assert.strictEqual(OpenFeature.getProvider(), first, 'evaluating a flag must not swap the provider');
});


test('refund succeeds when the feature flag backend is unreachable', async () => {
  await useUnreachableProvider();

  const result = await refund({ transactionId: 'txn-1', email: 'someone@example.com' });

  assert.ok(result.success, 'the refund must still be processed');
});

test('a resolved flag is used and recorded on the span', async () => {
  await OpenFeature.setProviderAndWait(workingProvider(0.5));

  const span = fakeSpan();
  const value = await flags.getNumber('paymentFailure', 0, span);

  assert.strictEqual(value, 0.5, 'should use the resolved value, not the default');
  assert.strictEqual(span.attributes['feature_flag.result.value'], 0.5);
  assert.strictEqual(span.attributes['feature_flag.result.variant'], 'test');
  assert.strictEqual(span.attributes['feature_flag.result.reason'], 'targeting_match',
    'semconv spells reasons lowercase');
  assert.strictEqual(span.events.length, 0, 'a successful lookup emits no error event');
});
