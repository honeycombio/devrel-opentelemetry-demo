// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0
const { context, propagation, trace, metrics, SpanStatusCode } = require('@opentelemetry/api');
const { ATTR_ERROR_TYPE } = require('@opentelemetry/semantic-conventions');
const cardValidator = require('simple-card-validator');
const { v4: uuidv4 } = require('uuid');

const flags = require('./featureFlags');
const logger = require('./logger');
const transactions = require('./transactionStore');
const tracer = trace.getTracer('payment');
const meter = metrics.getMeter('payment');
const transactionsCounter = meter.createCounter('demo.payment.transactions', {
  unit: '{transaction}',
});

const LOYALTY_LEVEL = ['platinum', 'gold', 'silver', 'bronze'];

// Decline reasons a card issuer's authorization network can return.
const ISSUER_DECLINE_REASONS = [
  'do_not_honor',
  'issuer_unavailable',
  'suspected_fraud',
  'insufficient_funds',
];

/** Return random element from given array */
function random(arr) {
  const index = Math.floor(Math.random() * arr.length);
  return arr[index];
}

module.exports.charge = async request => {
  const span = tracer.startSpan('charge');

  try {
    // If flagd is unreachable this comes back as 0 and no charge is declined.
    const failureRate = await flags.getNumber('paymentFailure', 0, span);

    if (failureRate > 0 && Math.random() < failureRate) {
      // n% chance the issuer's authorization network declines the charge
      const declineReason = random(ISSUER_DECLINE_REASONS);
      span.setAttributes({ 'app.payment.declined': true, 'app.payment.decline_reason': declineReason });
      throw new Error(`Payment declined by card issuer: ${declineReason}`);
    }

    const {
      creditCardNumber: number,
      creditCardExpirationYear: year,
      creditCardExpirationMonth: month
    } = request.creditCard;
    const currentMonth = new Date().getMonth() + 1;
    const currentYear = new Date().getFullYear();
    const lastFourDigits = number.substr(-4);
    const transactionId = uuidv4();

    const card = cardValidator(number);
    const { card_type: cardType, valid } = card.getCardDetails();

    const loyalty_level = random(LOYALTY_LEVEL);

    span.setAttributes({
      'demo.payment.card_type': cardType,
      'demo.payment.card_valid': valid,
      'demo.user_context.loyalty_level': loyalty_level
    });

    if (!valid) {
      throw new Error('Credit card info is invalid.');
    }

    if ((currentYear * 12 + currentMonth) > (year * 12 + month)) {
      throw new Error(`The credit card (ending ${lastFourDigits}) expired on ${month}/${year}.`);
    }

    // Check baggage for synthetic_request=true, and add charged attribute accordingly
    const baggage = propagation.getBaggage(context.active());
    const synthetic = baggage?.getEntry('synthetic_request')?.value === 'true';
    span.setAttributes({
      'demo.payment.charged': !synthetic,
      'app.payment.transaction.id': transactionId
    });

    const { units, nanos, currencyCode } = request.amount;
    logger.info({ transactionId, cardType, lastFourDigits, amount: { units, nanos, currencyCode }, loyalty_level }, 'Transaction complete.');
    transactionsCounter.add(1, { 'demo.payment.currency': currencyCode });

    transactions.set(transactionId, { status: 'charged', amount: request.amount });

    return { transactionId };
  } catch (err) {
    span.recordException(err);
    span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
    span.setAttribute(ATTR_ERROR_TYPE, err.name || 'Error');

    throw err;
  } finally {
    span.end();
  }
};
