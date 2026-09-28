// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"go.opentelemetry.io/otel/attribute"
	otelcodes "go.opentelemetry.io/otel/codes"
)

const idpBaseURL = "https://sso.keystone-id.example/api/v1/tenants"

var errAssertionRejected = errors.New("identity provider rejected the assertion")

// verifySSOAssertion asks the tenant's identity provider to confirm the user's SSO assertion.
func (a *auth) verifySSOAssertion(ctx context.Context, user *corporateUser) error {
	ctx, span := tracer.Start(ctx, "VerifySSOAssertion")
	defer span.End()
	span.SetAttributes(attribute.String("app.auth.idp", "keystone-id"))

	if user.IdpTenant == nil {
		err := fmt.Errorf("company %s has no identity provider tenant", user.CompanyID)
		span.RecordError(err)
		span.SetStatus(otelcodes.Error, err.Error())
		return err
	}
	span.SetAttributes(attribute.String("app.auth.idp_tenant", *user.IdpTenant))

	body, _ := json.Marshal(map[string]string{"subject": user.Email})
	url := fmt.Sprintf("%s/%s/assertions/verify", idpBaseURL, *user.IdpTenant)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := a.httpClient.Do(req)
	if err != nil {
		span.RecordError(err)
		span.SetStatus(otelcodes.Error, "identity provider unreachable")
		return err
	}
	defer resp.Body.Close()

	var result struct {
		Valid bool `json:"valid"`
	}
	if resp.StatusCode != http.StatusOK || json.NewDecoder(resp.Body).Decode(&result) != nil || !result.Valid {
		span.SetStatus(otelcodes.Error, errAssertionRejected.Error())
		return errAssertionRejected
	}
	return nil
}
