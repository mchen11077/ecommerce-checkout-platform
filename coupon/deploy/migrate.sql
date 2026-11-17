\set ON_ERROR_STOP on
BEGIN;
SELECT pg_advisory_xact_lock(748016041);
CREATE TABLE IF NOT EXISTS coupon_schema_migration (
    version integer PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
);
SELECT NOT EXISTS (SELECT FROM coupon_schema_migration WHERE version = 1) AS pending \gset
\if :pending
    \ir ../app/src/main/resources/schema.sql
    INSERT INTO coupon_schema_migration (version) VALUES (1);
\endif
SELECT NOT EXISTS (SELECT FROM coupon_schema_migration WHERE version = 2) AS pending \gset
\if :pending
    CREATE INDEX IF NOT EXISTS coupon_claim_user_idx ON coupon_claim (user_id, claimed_at DESC);
    INSERT INTO coupon_schema_migration (version) VALUES (2);
\endif
SELECT NOT EXISTS (SELECT FROM coupon_schema_migration WHERE version = 3) AS pending \gset
\if :pending
    ALTER TABLE coupon ADD COLUMN IF NOT EXISTS gift_name VARCHAR(120);
    ALTER TABLE checkout_order ADD COLUMN IF NOT EXISTS gift_name VARCHAR(120);
    INSERT INTO coupon_schema_migration (version) VALUES (3);
\endif
SELECT NOT EXISTS (SELECT FROM coupon_schema_migration WHERE version = 4) AS pending \gset
\if :pending
    ALTER TABLE checkout_order ALTER COLUMN coupon_id DROP NOT NULL;
    INSERT INTO coupon_schema_migration (version) VALUES (4);
\endif
SELECT NOT EXISTS (SELECT FROM coupon_schema_migration WHERE version = 5) AS pending \gset
\if :pending
    ALTER TABLE checkout_order ADD COLUMN IF NOT EXISTS cart_items TEXT;
    ALTER TABLE checkout_order ALTER COLUMN product_id DROP NOT NULL;
    INSERT INTO coupon_schema_migration (version) VALUES (5);
\endif
SELECT NOT EXISTS (SELECT FROM coupon_schema_migration WHERE version = 6) AS pending \gset
\if :pending
    \ir ../app/src/main/resources/schema.sql
    INSERT INTO coupon_schema_migration (version) VALUES (6);
\endif
SELECT NOT EXISTS (SELECT FROM coupon_schema_migration WHERE version = 7) AS pending \gset
\if :pending
    \ir ../app/src/main/resources/schema.sql
    INSERT INTO coupon_schema_migration (version) VALUES (7);
\endif
COMMIT;
