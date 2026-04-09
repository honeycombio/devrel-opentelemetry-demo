// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0
const { trace } = require('@opentelemetry/api');

const transactions = require('./transactionStore');
const tracer = trace.getTracer('payment');

module.exports.getPaymentStatus = async request => {
  const span = tracer.startSpan('getPaymentStatus');

  const { transactionId } = request;
  const transaction = transactions.get(transactionId);

  const status = transaction ? transaction.status : 'unknown';
  const amount = transaction ? transaction.amount : null;

  span.end();

  return { transactionId, status, amount };
};
