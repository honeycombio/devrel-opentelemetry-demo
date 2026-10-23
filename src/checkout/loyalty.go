// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0
package main

import (
	"context"
	"regexp"
	"strconv"

	"go.opentelemetry.io/otel/attribute"
)

// Loyalty codes reward returning customers. On top of the code's own percent_off, the
// customer gets 1% for every 10% they have saved with promo codes before, up to
// loyaltyMaxPercent in total.

const loyaltyMaxPercent = 30

// Promo-engine codes are a campaign name followed by the percent off: SAVE25, WELCOME15.
var promoCodePattern = regexp.MustCompile(`^([A-Z]+)([0-9]+)$`)

// percentFromCode reads the percent off out of a promo code, e.g. 25 for SAVE25.
func percentFromCode(code string) int {
	m := promoCodePattern.FindStringSubmatch(code)
	pct, _ := strconv.Atoi(m[2])
	return pct
}

// loyaltyPercent is the percent off for a loyalty code: base plus the customer's loyalty bonus.
func (cs *checkout) loyaltyPercent(ctx context.Context, email string, base int) int {
	ctx, span := tracer.Start(ctx, "calculateLoyaltyBonus")
	defer span.End()

	codes, err := cs.promos.redeemedCodes(ctx, email)
	if err != nil {
		span.RecordError(err)
		return base
	}
	span.SetAttributes(attribute.Int("app.loyalty.past_codes.count", len(codes)))

	saved := 0
	for _, code := range codes {
		saved += percentFromCode(code)
	}
	pct := min(base+saved/10, loyaltyMaxPercent)

	span.SetAttributes(
		attribute.Int("app.loyalty.past_percent.total", saved),
		attribute.Int("app.loyalty.percent_off", pct),
	)
	return pct
}
