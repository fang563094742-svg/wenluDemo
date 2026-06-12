-- 能力共享池 Schema（与 src/capability-pool/schema.sql 保持一致）

CREATE TABLE IF NOT EXISTS capability_pool (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            VARCHAR(200) NOT NULL UNIQUE,
  description     TEXT NOT NULL,
  command         TEXT NOT NULL,
  steps           JSONB NOT NULL DEFAULT '[]',
  builds_on       JSONB NOT NULL DEFAULT '[]',
  status          VARCHAR(30) NOT NULL DEFAULT 'pending',
  auto_review     JSONB DEFAULT NULL,
  reviewed_by     VARCHAR(100),
  reviewed_at     TIMESTAMPTZ,
  review_note     TEXT,
  contributed_by  UUID NOT NULL REFERENCES users(id),
  contributor_count INTEGER NOT NULL DEFAULT 1,
  inherit_count   INTEGER NOT NULL DEFAULT 0,
  use_count       INTEGER NOT NULL DEFAULT 0,
  success_count   INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_capability_pool_status ON capability_pool(status);
CREATE INDEX IF NOT EXISTS idx_capability_pool_name ON capability_pool(name);

CREATE TABLE IF NOT EXISTS capability_contributions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  capability_id     UUID NOT NULL REFERENCES capability_pool(id) ON DELETE CASCADE,
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  original_name     VARCHAR(200) NOT NULL,
  original_command  TEXT NOT NULL,
  forged_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(capability_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_cap_contrib_capability ON capability_contributions(capability_id);
CREATE INDEX IF NOT EXISTS idx_cap_contrib_user ON capability_contributions(user_id);

CREATE TABLE IF NOT EXISTS capability_inheritances (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  capability_id   UUID NOT NULL REFERENCES capability_pool(id) ON DELETE CASCADE,
  inherited_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, capability_id)
);

CREATE INDEX IF NOT EXISTS idx_cap_inherit_user ON capability_inheritances(user_id);
