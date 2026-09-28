// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"

	"go.opentelemetry.io/otel/attribute"
	otelcodes "go.opentelemetry.io/otel/codes"
)

var errUserNotCurrent = errors.New("user is no longer active at their company")

// statusCheckURL is the tenant's configured endpoint, or the conventional one on the tenant's domain.
func statusCheckURL(user *corporateUser) string {
	if user.StatusCheckURL != nil && *user.StatusCheckURL != "" {
		return fmt.Sprintf("%s/%s", *user.StatusCheckURL, user.ID)
	}
	return fmt.Sprintf("https://sso-status.%s/v1/users/%s", user.Domain, user.ID)
}

// checkUserStatus asks the user's company whether they are still an active employee.
// Tenants that enforce the check block logins that fail it; for everyone else a failed
// check is logged and the login continues.
func (a *auth) checkUserStatus(ctx context.Context, user *corporateUser) error {
	ctx, span := tracer.Start(ctx, "CheckUserStatus")
	defer span.End()
	span.SetAttributes(attribute.Bool("app.auth.status_check.enforced", user.EnforceStatusCheck))

	status, err := a.fetchUserStatus(ctx, user)
	if err != nil {
		span.RecordError(err)
		span.SetStatus(otelcodes.Error, "user status check failed")
		span.SetAttributes(attribute.String("app.auth.status_check.result", "error"))
		logger.WarnContext(ctx, "user status check failed",
			slog.String("company", user.CompanyID), slog.String("error", err.Error()))
		if user.EnforceStatusCheck {
			return err
		}
		return nil
	}

	if status != "active" {
		span.SetAttributes(attribute.String("app.auth.status_check.result", "not_current"))
		logger.InfoContext(ctx, "user is not current", slog.String("company", user.CompanyID))
		if user.EnforceStatusCheck {
			return errUserNotCurrent
		}
		return nil
	}
	span.SetAttributes(attribute.String("app.auth.status_check.result", "active"))
	return nil
}

func (a *auth) fetchUserStatus(ctx context.Context, user *corporateUser) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, statusCheckURL(user), nil)
	if err != nil {
		return "", err
	}
	resp, err := a.httpClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("status endpoint returned %d", resp.StatusCode)
	}
	var body struct {
		Status string `json:"status"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return "", fmt.Errorf("unreadable status response: %w", err)
	}
	return body.Status, nil
}
