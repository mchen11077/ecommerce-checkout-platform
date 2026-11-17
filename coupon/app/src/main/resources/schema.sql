-- Step 1.1: two tables. The (coupon_id, user_id) unique constraint stops one user claiming twice,
-- and in Phase 4 it is what makes the Kafka consumer idempotent (ON CONFLICT DO NOTHING).
CREATE TABLE IF NOT EXISTS coupon (
    id          BIGSERIAL PRIMARY KEY,
    name        TEXT        NOT NULL,
    total_stock INT         NOT NULL,
    stock       INT         NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS coupon_claim (
    id         BIGSERIAL PRIMARY KEY,
    coupon_id  BIGINT      NOT NULL REFERENCES coupon(id),
    user_id    BIGINT      NOT NULL,
    source     TEXT        NOT NULL,
    claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_claim UNIQUE (coupon_id, user_id)
);

-- Step 1.1 (issue / redeem / eligibility). ADD COLUMN IF NOT EXISTS so an old database still upgrades.
-- status: DRAFT = created, ACTIVE = issued (loaded into Redis, open for claiming)
ALTER TABLE coupon ADD COLUMN IF NOT EXISTS status           TEXT          NOT NULL DEFAULT 'DRAFT';
ALTER TABLE coupon ADD COLUMN IF NOT EXISTS min_order_amount NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE coupon ADD COLUMN IF NOT EXISTS discount_amount  NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE coupon ADD COLUMN IF NOT EXISTS valid_from       TIMESTAMPTZ   NOT NULL DEFAULT now();
ALTER TABLE coupon ADD COLUMN IF NOT EXISTS valid_until      TIMESTAMPTZ   NOT NULL DEFAULT now() + INTERVAL '30 days';

-- Claim status becomes REDEEMED when all uses have been spent.
ALTER TABLE coupon_claim ADD COLUMN IF NOT EXISTS status      TEXT        NOT NULL DEFAULT 'CLAIMED';
ALTER TABLE coupon_claim ADD COLUMN IF NOT EXISTS redeemed_at TIMESTAMPTZ;
ALTER TABLE coupon_claim ADD COLUMN IF NOT EXISTS order_id    TEXT;

CREATE TABLE IF NOT EXISTS checkout_order (
    user_id        BIGINT NOT NULL,
    order_id       UUID NOT NULL,
    product_id     TEXT NOT NULL,
    coupon_id      BIGINT NOT NULL REFERENCES coupon(id),
    subtotal_cents INT NOT NULL CHECK (subtotal_cents >= 0),
    discount_cents INT NOT NULL CHECK (discount_cents BETWEEN 0 AND subtotal_cents),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, order_id)
);

ALTER TABLE coupon ADD COLUMN IF NOT EXISTS gift_name VARCHAR(120);
ALTER TABLE checkout_order ADD COLUMN IF NOT EXISTS gift_name VARCHAR(120);
ALTER TABLE checkout_order ALTER COLUMN coupon_id DROP NOT NULL;
ALTER TABLE checkout_order ADD COLUMN IF NOT EXISTS cart_items TEXT;
ALTER TABLE checkout_order ALTER COLUMN product_id DROP NOT NULL;

ALTER TABLE checkout_order ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'DEMO';
ALTER TABLE checkout_order ADD COLUMN IF NOT EXISTS shipping_status TEXT NOT NULL DEFAULT 'UNSHIPPED';
CREATE TABLE IF NOT EXISTS product_inventory (
    product_id TEXT PRIMARY KEY,
    available INTEGER NOT NULL CHECK (available >= 0)
);
INSERT INTO product_inventory (product_id, available)
VALUES ('silicone-utensils', 20), ('nonstick-skillet', 20), ('stainless-stockpot', 20),
       ('glass-storage', 20), ('canvas-tote', 100), ('weekender-bag', 100)
ON CONFLICT (product_id) DO NOTHING;

ALTER TABLE coupon ADD COLUMN IF NOT EXISTS max_uses_per_user INTEGER NOT NULL DEFAULT 1 CHECK (max_uses_per_user > 0);
ALTER TABLE coupon_claim ADD COLUMN IF NOT EXISTS use_count INTEGER NOT NULL DEFAULT 0 CHECK (use_count >= 0);
UPDATE coupon_claim SET use_count = 1 WHERE status = 'REDEEMED' AND use_count = 0;
CREATE TABLE IF NOT EXISTS coupon_redemption (
    coupon_id BIGINT NOT NULL,
    user_id BIGINT NOT NULL,
    order_id TEXT NOT NULL,
    PRIMARY KEY (coupon_id, user_id, order_id),
    FOREIGN KEY (coupon_id, user_id) REFERENCES coupon_claim(coupon_id, user_id)
);
