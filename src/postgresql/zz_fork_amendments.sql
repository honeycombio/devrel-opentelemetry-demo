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

-- pg_cron: expire orders older than 48 hours (runs every hour). Table-level
-- GRANTs from init.sql already cover these new columns, no re-grant needed.
CREATE EXTENSION IF NOT EXISTS pg_cron;
SELECT cron.schedule('expire-orders', '0 * * * *',
    $$DELETE FROM accounting."order" WHERE created_at < NOW() - INTERVAL '48 hours'$$);
