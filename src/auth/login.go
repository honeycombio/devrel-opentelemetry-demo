// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0
package main

import (
	"context"
	"errors"
	"log/slog"
	"strings"

	"github.com/open-feature/go-sdk/openfeature"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/baggage"
	otelcodes "go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/trace"
	"golang.org/x/crypto/bcrypt"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "github.com/open-telemetry/opentelemetry-demo/src/auth/genproto/oteldemo"
)

const (
	methodPassword = "password"
	methodSSO      = "sso"

	resultSuccess           = "success"
	resultBadPassword       = "bad_password"
	resultUnknownUser       = "unknown_user"
	resultMethodMismatch    = "method_mismatch"
	resultIdpError          = "idp_error"
	resultUserNotCurrent    = "user_not_current"
	resultStatusCheckFailed = "status_check_failed"
	resultError             = "error"
)

func (a *auth) Login(ctx context.Context, req *pb.LoginRequest) (*pb.LoginResponse, error) {
	span := trace.SpanFromContext(ctx)

	method := strings.ToLower(req.Method)
	if method == "" {
		method = methodPassword
	}
	span.SetAttributes(
		attribute.String("app.auth.method", method),
		attribute.String("app.auth.email_domain", emailDomain(req.Email)),
	)
	if sessionID := baggage.FromContext(ctx).Member("session.id").Value(); sessionID != "" {
		span.SetAttributes(
			attribute.String("session.id", sessionID),
			attribute.String("app.user.id", sessionID),
		)
	}

	user, result, err := a.authenticate(ctx, req, method)

	company := ""
	if user != nil {
		company = user.CompanyID
	}
	span.SetAttributes(attribute.String("app.auth.result", result))
	a.auditLogin(ctx, user, method, result)
	a.logins.Add(ctx, 1, metric.WithAttributes(
		attribute.String("app.company", company),
		attribute.String("app.auth.method", method),
		attribute.String("app.auth.result", result),
	))
	logger.LogAttrs(ctx, slog.LevelInfo, "login",
		slog.String("company", company),
		slog.String("method", method),
		slog.String("result", result),
	)

	if err != nil {
		return nil, err
	}
	return &pb.LoginResponse{
		CorporateUserId: user.ID,
		Company:         user.CompanyID,
		CompanyName:     user.CompanyName,
		Email:           user.Email,
		DisplayName:     user.DisplayName,
	}, nil
}

// authenticate returns the user (when known), the login result, and the gRPC error to return, if any.
func (a *auth) authenticate(ctx context.Context, req *pb.LoginRequest, method string) (*corporateUser, string, error) {
	span := trace.SpanFromContext(ctx)

	user, err := a.store.findUserByEmail(ctx, req.Email)
	if errors.Is(err, errUserNotFound) {
		return nil, resultUnknownUser, status.Error(codes.Unauthenticated, "invalid email or password")
	}
	if err != nil {
		span.RecordError(err)
		return nil, resultError, status.Error(codes.Internal, "could not look up user")
	}
	span.SetAttributes(
		attribute.String("app.company", user.CompanyID),
		attribute.String("app.corporate_user.id", user.ID),
	)

	if user.LoginMethod != method {
		return user, resultMethodMismatch,
			status.Errorf(codes.FailedPrecondition, "%s uses %s sign-in", user.CompanyName, user.LoginMethod)
	}

	switch method {
	case methodPassword:
		if !verifyPassword(ctx, user, req.Password) {
			return user, resultBadPassword, status.Error(codes.Unauthenticated, "invalid email or password")
		}
	case methodSSO:
		if err := a.verifySSOAssertion(ctx, user); err != nil {
			logger.WarnContext(ctx, "sso verification failed", slog.String("company", user.CompanyID), slog.String("error", err.Error()))
			return user, resultIdpError, status.Error(codes.Unavailable, "single sign-on is unavailable")
		}
		evalCtx := openfeature.NewEvaluationContext(user.ID, map[string]any{"company": user.CompanyID})
		if check, _ := a.flags.BooleanValue(ctx, "auth.user-status-check", false, evalCtx); check {
			if err := a.checkUserStatus(ctx, user); err != nil {
				result := resultStatusCheckFailed
				if errors.Is(err, errUserNotCurrent) {
					result = resultUserNotCurrent
				}
				return user, result, status.Error(codes.PermissionDenied, "your account is not active at your company")
			}
		}
	default:
		return user, resultMethodMismatch, status.Errorf(codes.InvalidArgument, "unknown login method %q", method)
	}

	if err := a.store.recordLogin(ctx, user.ID); err != nil {
		span.RecordError(err)
	}
	return user, resultSuccess, nil
}

func verifyPassword(ctx context.Context, user *corporateUser, password string) bool {
	_, span := tracer.Start(ctx, "VerifyPassword")
	defer span.End()
	span.SetAttributes(
		attribute.String("app.auth.hash_algorithm", "bcrypt"),
		attribute.Int("app.auth.hash_cost", bcrypt.DefaultCost),
	)
	if user.PasswordHash == nil {
		span.SetStatus(otelcodes.Error, "no password set")
		return false
	}
	ok := bcrypt.CompareHashAndPassword([]byte(*user.PasswordHash), []byte(password)) == nil
	span.SetAttributes(attribute.Bool("app.auth.password_match", ok))
	return ok
}

func emailDomain(email string) string {
	if i := strings.LastIndex(email, "@"); i >= 0 {
		return strings.ToLower(email[i+1:])
	}
	return ""
}
