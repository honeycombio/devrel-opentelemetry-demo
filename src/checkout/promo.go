// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"

	"github.com/exaring/otelpgx"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.opentelemetry.io/otel/attribute"
	otelcodes "go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"

	pb "github.com/open-telemetry/opentelemetry-demo/src/checkout/genproto/oteldemo"
	"github.com/open-telemetry/opentelemetry-demo/src/checkout/money"
)

// Promo codes live in Postgres, in the promotions schema. Any customer can use any active
// code; it takes percent_off off the item subtotal.

var errPromoNotFound = errors.New("promo code not found")

type promoCode struct {
	Code       string
	PercentOff int
	Active     bool
}

type promoStore struct {
	pool *pgxpool.Pool
}

func newPromoStore(ctx context.Context, connString string) (*promoStore, error) {
	cfg, err := pgxpool.ParseConfig(connString)
	if err != nil {
		return nil, err
	}
	cfg.ConnConfig.Tracer = otelpgx.NewTracer(
		otelpgx.WithTrimSQLInSpanName(),
		otelpgx.WithSpanNameFunc(spanName),
		otelpgx.WithDisableQuerySpanNamePrefix(),
	)
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, err
	}
	return &promoStore{pool: pool}, nil
}

func (s *promoStore) close() { s.pool.Close() }

func (s *promoStore) findPromoCode(ctx context.Context, code string) (*promoCode, error) {
	var p promoCode
	err := s.pool.QueryRow(ctx,
		`SELECT code, percent_off, active FROM promotions.promo_code WHERE code = $1`, code).Scan(
		&p.Code, &p.PercentOff, &p.Active)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errPromoNotFound
	}
	if err != nil {
		return nil, err
	}
	return &p, nil
}

func (s *promoStore) recordRedemption(ctx context.Context, email, code, orderID string) error {
	_, err := s.pool.Exec(ctx,
		`INSERT INTO promotions.redemption (email, code, order_id) VALUES ($1, $2, $3)`,
		email, code, orderID)
	return err
}

// spanName names otelpgx spans like "SELECT otel.promotions.customer_promo", matching auth.
func spanName(stmt string) string {
	fields := strings.Fields(stmt)
	if len(fields) == 0 {
		return "query"
	}
	op := strings.ToUpper(fields[0])
	var table string
	if op == "UPDATE" && len(fields) > 1 {
		table = fields[1]
	}
	for i := 0; table == "" && i+1 < len(fields); i++ {
		if kw := strings.ToUpper(fields[i]); kw == "FROM" || kw == "INTO" {
			table = fields[i+1]
		}
	}
	if table == "" {
		return op
	}
	return op + " otel." + strings.Trim(table, `"(`)
}

type appliedPromo struct {
	promo    *promoCode
	email    string
	discount *pb.Money
}

func normalizePromoCode(code string) string { return strings.ToUpper(strings.TrimSpace(code)) }

// applyPromoCode works out the discount for the code the customer entered, as a
// percentage of the item subtotal (before tax and shipping). A code that can't be
// used doesn't fail the order: it is charged at full price, and the reason is on the span.
func (cs *checkout) applyPromoCode(ctx context.Context, email, code string, items []*pb.OrderItem, currency string) *appliedPromo {
	ctx, span := tracer.Start(ctx, "applyPromoCode")
	defer span.End()

	email = strings.ToLower(strings.TrimSpace(email))
	code = normalizePromoCode(code)
	span.SetAttributes(attribute.String("app.promo.code", code))

	reject := func(result string) *appliedPromo {
		span.SetAttributes(attribute.String("app.promo.result", result))
		logger.LogAttrs(ctx, slog.LevelInfo, "promo code not applied",
			slog.String("app.promo.code", code), slog.String("app.promo.result", result))
		return nil
	}

	if cs.promos == nil {
		return reject("unavailable")
	}
	promo, err := cs.promos.findPromoCode(ctx, code)
	if errors.Is(err, errPromoNotFound) {
		return reject("unknown_code")
	}
	if err != nil {
		span.RecordError(err)
		span.SetStatus(otelcodes.Error, "promo lookup failed")
		return reject("lookup_failed")
	}
	span.SetAttributes(attribute.Int("app.promo.percent_off", promo.PercentOff))
	if !promo.Active {
		return reject("inactive")
	}

	subtotal := &pb.Money{CurrencyCode: currency}
	for _, it := range items {
		subtotal, err = money.Sum(subtotal, money.MultiplySlow(it.Cost, uint32(it.GetItem().GetQuantity())))
		if err != nil {
			span.RecordError(err)
			return reject("invalid_subtotal")
		}
	}
	discount := percentOf(subtotal, promo.PercentOff)

	span.SetAttributes(
		attribute.String("app.promo.result", "applied"),
		attribute.Float64("app.promo.discount.amount", moneyToFloat(discount)),
	)
	span.AddEvent("promo applied", trace.WithAttributes(attribute.String("app.promo.code", code)))
	return &appliedPromo{promo: promo, email: email, discount: discount}
}

// percentOf returns pct percent of m, rounded down to the nano.
func percentOf(m *pb.Money, pct int) *pb.Money {
	nanos := m.GetUnits()*1_000_000_000 + int64(m.GetNanos())
	d := nanos * int64(pct) / 100
	return &pb.Money{CurrencyCode: m.GetCurrencyCode(), Units: d / 1_000_000_000, Nanos: int32(d % 1_000_000_000)}
}

func moneyToFloat(m *pb.Money) float64 {
	return float64(m.GetUnits()) + float64(m.GetNanos())/1e9
}

func (cs *checkout) recordPromoRedemption(ctx context.Context, applied *appliedPromo, orderID string) {
	if err := cs.promos.recordRedemption(ctx, applied.email, applied.promo.Code, orderID); err != nil {
		logger.LogAttrs(ctx, slog.LevelWarn, "failed to record promo redemption",
			slog.String("app.promo.code", applied.promo.Code), slog.String("error", fmt.Sprintf("%v", err)))
	}
}
