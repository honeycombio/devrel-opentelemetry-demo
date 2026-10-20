// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0
package main

import (
	"testing"

	pb "github.com/open-telemetry/opentelemetry-demo/src/checkout/genproto/oteldemo"
)

func TestPercentOf(t *testing.T) {
	tests := []struct {
		in        *pb.Money
		pct       int
		wantUnits int64
		wantNanos int32
	}{
		{&pb.Money{Units: 100, CurrencyCode: "USD"}, 15, 15, 0},
		{&pb.Money{Units: 19, Nanos: 990_000_000, CurrencyCode: "USD"}, 10, 1, 999_000_000},
		{&pb.Money{Units: 0, Nanos: 0, CurrencyCode: "USD"}, 20, 0, 0},
	}
	for _, tt := range tests {
		got := percentOf(tt.in, tt.pct)
		if got.Units != tt.wantUnits || got.Nanos != tt.wantNanos || got.CurrencyCode != tt.in.CurrencyCode {
			t.Errorf("percentOf(%v, %d) = %v, want %d.%09d", tt.in, tt.pct, got, tt.wantUnits, tt.wantNanos)
		}
	}
}

func TestNormalizePromoCode(t *testing.T) {
	for in, want := range map[string]string{
		" thankyou10 ": "THANKYOU10",
		"café15":       "CAFÉ15",
		"welcome 5":    "WELCOME 5",
	} {
		if got := normalizePromoCode(in); got != want {
			t.Errorf("normalizePromoCode(%q) = %q, want %q", in, got, want)
		}
	}
}
