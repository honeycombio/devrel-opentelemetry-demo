// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0
package main

import (
	"context"
	"errors"
	"strings"

	"github.com/exaring/otelpgx"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var errUserNotFound = errors.New("user not found")

type corporateUser struct {
	ID           string
	Email        string
	DisplayName  string
	PasswordHash *string
	CompanyID    string
	CompanyName  string
	Domain       string
	LoginMethod  string
	IdpTenant    *string
}

type store struct {
	pool *pgxpool.Pool
}

func newStore(ctx context.Context, connString string) (*store, error) {
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
	return &store{pool: pool}, nil
}

func (s *store) close() { s.pool.Close() }

func (s *store) findUserByEmail(ctx context.Context, email string) (*corporateUser, error) {
	var u corporateUser
	err := s.pool.QueryRow(ctx, `
		SELECT u.corporate_user_id, u.email, u.display_name, u.password_hash,
		       c.company_id, c.name, c.domain, c.login_method, c.idp_tenant
		  FROM auth.corporate_user u
		  JOIN auth.company c ON c.company_id = u.company_id
		 WHERE u.email = $1`, strings.ToLower(email)).Scan(
		&u.ID, &u.Email, &u.DisplayName, &u.PasswordHash,
		&u.CompanyID, &u.CompanyName, &u.Domain, &u.LoginMethod, &u.IdpTenant)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errUserNotFound
	}
	if err != nil {
		return nil, err
	}
	return &u, nil
}

func (s *store) recordLogin(ctx context.Context, userID string) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE auth.corporate_user SET last_login_at = now() WHERE corporate_user_id = $1`, userID)
	return err
}

func (s *store) recordLoginEvent(ctx context.Context, userID, companyID *string, method, result string) error {
	_, err := s.pool.Exec(ctx,
		`INSERT INTO auth.login_event (corporate_user_id, company_id, method, result) VALUES ($1, $2, $3, $4)`,
		userID, companyID, method, result)
	return err
}

// spanName follows the database semconv shape "{operation} {database}.{table}",
// e.g. "SELECT otel.auth.corporate_user".
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
