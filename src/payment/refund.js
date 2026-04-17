// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0
const { trace, metrics } = require('@opentelemetry/api');
const { v4: uuidv4 } = require('uuid');

const { OpenFeature } = require('@openfeature/server-sdk');
const { FlagdProvider } = require('@openfeature/flagd-provider');
const flagProvider = new FlagdProvider();

const logger = require('./logger');
const transactions = require('./transactionStore');
const tracer = trace.getTracer('payment');
const meter = metrics.getMeter('payment');
const refundsCounter = meter.createCounter('app.payment.refunds');

module.exports.refund = async request => {
  const span = tracer.startSpan('refund');

  await OpenFeature.setProviderAndWait(flagProvider);

  const numberVariant = await OpenFeature.getClient().getNumberValue("paymentServiceRefundFailure", 0);

  if (numberVariant > 0) {
    if (Math.random() < numberVariant) {
      span.end();
      throw new Error('Refund request failed.');
    }

    // Deterministic failure for demo: emails ending in "125"
    const email = request.email || '';
    if (email.match(/125@/)) {
      span.setStatus({ code: 2, message: 'Payment processor declined refund' });
      span.end();
      throw new Error('Payment processor declined the refund request.');
    }
  }

  const { transactionId } = request;
  const refundTransactionId = uuidv4();

  transactions.set(transactionId, { status: 'refunded', amount: transactions.get(transactionId)?.amount });

  logger.info({ transactionId, refundTransactionId }, 'Refund complete.');
  refundsCounter.add(1);
  span.end();

  return { refundTransactionId, success: true };
};
