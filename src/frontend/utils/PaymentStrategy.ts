// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

// Type-only import: protos/demo.ts pulls in @grpc/grpc-js, which must not reach the browser bundle.
// So the values below are numeric copies of the proto enum -- keep them in sync with demo.proto.
import type { PaymentStrategy } from '../protos/demo';

const PS = {
  UNSPECIFIED: 0,
  CC_VISA: 1,
  CC_MASTERCARD: 2,
  CC_AMEX: 3,
  CC_DISCOVER: 4,
  CC_OTHER: 5,
} as const;

// Name the card network from the number, the way a checkout page does as you type.
// Deliberately NOT simple-card-validator (which payment uses): that library does not
// know the Mastercard 2-series, and the browser should.
const MASTERCARD_2_SERIES = /^(222[1-9]|22[3-9]\d|2[3-6]\d\d|27[01]\d|2720)/; // 2221-2720

export function paymentStrategyForCard(cardNumber: string): PaymentStrategy {
  const digits = cardNumber.replace(/\D/g, '');
  if (digits === '') return PS.UNSPECIFIED as PaymentStrategy;
  if (/^4/.test(digits)) return PS.CC_VISA as PaymentStrategy;
  if (/^5[1-5]/.test(digits) || MASTERCARD_2_SERIES.test(digits)) return PS.CC_MASTERCARD as PaymentStrategy;
  if (/^3[47]/.test(digits)) return PS.CC_AMEX as PaymentStrategy;
  if (/^(6011|65|64[4-9])/.test(digits)) return PS.CC_DISCOVER as PaymentStrategy;
  return PS.CC_OTHER as PaymentStrategy;
}

const DISPLAY_NAMES: Partial<Record<number, string>> = {
  [PS.CC_VISA]: 'Visa',
  [PS.CC_MASTERCARD]: 'Mastercard',
  [PS.CC_AMEX]: 'American Express',
  [PS.CC_DISCOVER]: 'Discover',
};

export function paymentStrategyDisplayName(strategy: PaymentStrategy): string {
  return DISPLAY_NAMES[strategy] ?? '';
}
