// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

import { PaymentStrategy } from '../protos/demo';

// Name the card network from the number, the way a checkout page does as you type.
// Deliberately NOT simple-card-validator (which payment uses): that library does not
// know the Mastercard 2-series, and the browser should.
const MASTERCARD_2_SERIES = /^(222[1-9]|22[3-9]\d|2[3-6]\d\d|27[01]\d|2720)/; // 2221-2720

export function paymentStrategyForCard(cardNumber: string): PaymentStrategy {
  const digits = cardNumber.replace(/\D/g, '');
  if (digits === '') return PaymentStrategy.PAYMENT_STRATEGY_UNSPECIFIED;
  if (/^4/.test(digits)) return PaymentStrategy.CC_VISA;
  if (/^5[1-5]/.test(digits) || MASTERCARD_2_SERIES.test(digits)) return PaymentStrategy.CC_MASTERCARD;
  if (/^3[47]/.test(digits)) return PaymentStrategy.CC_AMEX;
  if (/^(6011|65|64[4-9])/.test(digits)) return PaymentStrategy.CC_DISCOVER;
  return PaymentStrategy.CC_OTHER;
}

const DISPLAY_NAMES: Partial<Record<PaymentStrategy, string>> = {
  [PaymentStrategy.CC_VISA]: 'Visa',
  [PaymentStrategy.CC_MASTERCARD]: 'Mastercard',
  [PaymentStrategy.CC_AMEX]: 'American Express',
  [PaymentStrategy.CC_DISCOVER]: 'Discover',
};

export function paymentStrategyDisplayName(strategy: PaymentStrategy): string {
  return DISPLAY_NAMES[strategy] ?? '';
}
