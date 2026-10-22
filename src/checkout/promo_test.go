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

// A sub-$1 item first used to make money.Sum produce an invalid running total.
func TestItemSubtotal(t *testing.T) {
	items := []*pb.OrderItem{
		{Item: &pb.CartItem{ProductId: "HQTGWGPNH4", Quantity: 1}, Cost: &pb.Money{CurrencyCode: "USD", Nanos: 990_000_000}},
		{Item: &pb.CartItem{ProductId: "0PUK6V6EV0", Quantity: 2}, Cost: &pb.Money{CurrencyCode: "USD", Units: 101, Nanos: 960_000_000}},
	}
	got := itemSubtotal(items, "USD")
	if got.Units != 204 || got.Nanos != 910_000_000 || got.CurrencyCode != "USD" {
		t.Errorf("itemSubtotal = %v, want USD 204.91", got)
	}
}
