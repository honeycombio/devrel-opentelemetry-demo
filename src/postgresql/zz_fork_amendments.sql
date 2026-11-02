-- Copyright The OpenTelemetry Authors
-- SPDX-License-Identifier: Apache-2.0

-- Fork amendment layered on top of init.sql (kept an unmodified copy of
-- upstream's src/postgresql/init.sql so it merges cleanly from upstream/main
-- going forward). docker-entrypoint-initdb.d runs *.sql files in filename
-- order; "zz_" sorts after "init.sql" so astronomy_user/astronomy_db/the
-- accounting and catalog schemas already exist by the time this runs.

\connect astronomy_db

-- Accounting Service: extend the order table with the columns our
-- order-status/refund feature (accounting's OrderService gRPC, storechat)
-- needs. Upstream's accounting.order is just order_id.
ALTER TABLE accounting."order"
    ADD COLUMN email TEXT,                             -- optional, from checkout
    ADD COLUMN user_id TEXT,                            -- session UUID
    ADD COLUMN transaction_id TEXT,                      -- from payment service
    ADD COLUMN total_cost_currency_code TEXT,
    ADD COLUMN total_cost_units BIGINT,
    ADD COLUMN total_cost_nanos INT,
    ADD COLUMN order_status TEXT NOT NULL DEFAULT 'completed',  -- completed | refunded
    ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ADD COLUMN refunded_at TIMESTAMPTZ;
CREATE INDEX idx_order_email ON accounting."order"(email);

-- Auth Service: schema and tables (corporate login, SSO). The tenants and
-- users are seeded by zz_fork_auth_seed.sql.
CREATE SCHEMA auth;
GRANT USAGE ON SCHEMA auth TO astronomy_user;

CREATE TABLE auth.company (
    company_id TEXT PRIMARY KEY,             -- slug, e.g. 'globex'
    name TEXT NOT NULL,
    domain TEXT NOT NULL UNIQUE,
    login_method TEXT NOT NULL CHECK (login_method IN ('password', 'sso')),
    idp_tenant TEXT                          -- SSO tenants only
);

CREATE TABLE auth.corporate_user (
    corporate_user_id TEXT PRIMARY KEY,      -- usr_...
    company_id TEXT NOT NULL REFERENCES auth.company(company_id),
    email TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    password_hash TEXT,                      -- password tenants only
    last_login_at TIMESTAMPTZ
);
CREATE INDEX idx_corporate_user_company ON auth.corporate_user(company_id);

CREATE TABLE auth.login_event (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    corporate_user_id TEXT,
    company_id TEXT,
    method TEXT NOT NULL,
    result TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Per-tenant post-SSO employee status check. No row: default URL on the tenant's domain, not enforced.
CREATE TABLE auth.sso_status_check (
    company_id TEXT PRIMARY KEY REFERENCES auth.company(company_id),
    url_override TEXT,
    enforce BOOLEAN NOT NULL DEFAULT false
);

GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA auth TO astronomy_user;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA auth TO astronomy_user;

-- pg_cron: expire orders older than 48 hours (runs every hour). Table-level
-- GRANTs from init.sql already cover these new columns, no re-grant needed.
CREATE EXTENSION IF NOT EXISTS pg_cron;
SELECT cron.schedule('expire-orders', '0 * * * *',
    $$DELETE FROM accounting."order" WHERE created_at < NOW() - INTERVAL '48 hours'$$);
