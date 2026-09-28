// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0
package main

import (
	"context"
	"log/slog"

	"github.com/open-feature/go-sdk/openfeature"
	"go.opentelemetry.io/otel/trace"
)

// auditLogin records the login attempt in auth.login_event, when audit logging is on.
func (a *auth) auditLogin(ctx context.Context, user *corporateUser, method, result string) {
	if on, _ := a.flags.BooleanValue(ctx, "auth.login-audit-log", false, openfeature.EvaluationContext{}); !on {
		return
	}
	var userID, companyID *string
	if user != nil {
		userID, companyID = &user.ID, &user.CompanyID
	}
	if err := a.store.recordLoginEvent(ctx, userID, companyID, method, result); err != nil {
		trace.SpanFromContext(ctx).RecordError(err)
		logger.WarnContext(ctx, "could not record login event", slog.String("error", err.Error()))
	}
}
