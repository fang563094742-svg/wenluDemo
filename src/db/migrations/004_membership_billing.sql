-- 会员订单 / 支付流水 / 权益发放骨架

CREATE TABLE IF NOT EXISTS membership_orders (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_no         VARCHAR(64) NOT NULL UNIQUE,
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id          VARCHAR(50) NOT NULL REFERENCES plans(id),
  order_type       VARCHAR(32) NOT NULL DEFAULT 'recharge',
  amount_cents     INTEGER NOT NULL,
  currency         VARCHAR(16) NOT NULL DEFAULT 'CNY',
  status           VARCHAR(32) NOT NULL DEFAULT 'pending',
  payment_channel  VARCHAR(50),
  idempotency_key  VARCHAR(100),
  client_reference VARCHAR(100),
  title            VARCHAR(200),
  metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,
  review_status    VARCHAR(32) NOT NULL DEFAULT 'not_required',
  review_reason    TEXT,
  reviewed_by      VARCHAR(100),
  reviewed_at      TIMESTAMPTZ,
  expires_at       TIMESTAMPTZ,
  paid_at          TIMESTAMPTZ,
  fulfilled_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_membership_orders_idempotency
  ON membership_orders(idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_membership_orders_user
  ON membership_orders(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_membership_orders_status
  ON membership_orders(status, review_status, created_at DESC);

CREATE TABLE IF NOT EXISTS order_payments (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id                UUID NOT NULL REFERENCES membership_orders(id) ON DELETE CASCADE,
  user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel                 VARCHAR(50) NOT NULL,
  provider                VARCHAR(50) NOT NULL DEFAULT 'manual',
  provider_transaction_id VARCHAR(200),
  amount_cents            INTEGER NOT NULL,
  currency                VARCHAR(16) NOT NULL DEFAULT 'CNY',
  status                  VARCHAR(32) NOT NULL DEFAULT 'pending',
  callback_payload        JSONB NOT NULL DEFAULT '{}'::jsonb,
  paid_at                 TIMESTAMPTZ,
  confirmed_at            TIMESTAMPTZ,
  review_status           VARCHAR(32) NOT NULL DEFAULT 'not_required',
  review_note             TEXT,
  reviewed_by             VARCHAR(100),
  reviewed_at             TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(provider, provider_transaction_id)
);

CREATE INDEX IF NOT EXISTS idx_order_payments_order
  ON order_payments(order_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_order_payments_user
  ON order_payments(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_order_payments_status
  ON order_payments(status, review_status, created_at DESC);

CREATE TABLE IF NOT EXISTS membership_grants (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        UUID NOT NULL UNIQUE REFERENCES membership_orders(id) ON DELETE CASCADE,
  payment_id      UUID REFERENCES order_payments(id) ON DELETE SET NULL,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id         VARCHAR(50) NOT NULL REFERENCES plans(id),
  subscription_id UUID NOT NULL UNIQUE REFERENCES subscriptions(id) ON DELETE CASCADE,
  source          VARCHAR(32) NOT NULL DEFAULT 'payment',
  grant_status    VARCHAR(32) NOT NULL DEFAULT 'active',
  starts_at       TIMESTAMPTZ NOT NULL,
  expires_at      TIMESTAMPTZ,
  granted_by      VARCHAR(100),
  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_membership_grants_user
  ON membership_grants(user_id, created_at DESC);
