// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0
const { trace, metrics, SpanStatusCode } = require('@opentelemetry/api');
const { v4: uuidv4 } = require('uuid');

const flags = require('./featureFlags');
const logger = require('./logger');
const transactions = require('./transactionStore');
const tracer = trace.getTracer('payment');
const meter = metrics.getMeter('payment');
const refundsCounter = meter.createCounter('app.payment.refunds');

module.exports.refund = async request => {
  const span = tracer.startSpan('refund');

  try {
    // If flagd is unreachable this comes back as 0 and no refund is failed.
    const failureRate = await flags.getNumber('paymentServiceRefundFailure', 0, span);

    if (failureRate > 0) {
      if (Math.random() < failureRate) {
        throw new Error('Refund request failed.');
      }

      // Deterministic failure for demo: emails ending in "125"
      const email = request.email || '';
      if (email.match(/125@/)) {
        throw new Error('Payment processor declined the refund request.');
      }
    }

    const { transactionId } = request;
    const refundTransactionId = uuidv4();

    transactions.set(transactionId, { status: 'refunded', amount: transactions.get(transactionId)?.amount });

    span.setAttribute('app.payment.transaction.id', transactionId);

    logger.info({ transactionId, refundTransactionId }, 'Refund complete.');
    refundsCounter.add(1);

    return { refundTransactionId, success: true };
  } catch (err) {
    span.recordException(err);
    span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
    throw err;
  } finally {
    span.end();
  }
};
