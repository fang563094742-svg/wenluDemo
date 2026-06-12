-- 邀请奖励规则 / 发放记录

CREATE TABLE IF NOT EXISTS invite_reward_policies (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 VARCHAR(120) NOT NULL,
  description          TEXT,
  trigger_type         VARCHAR(32) NOT NULL CHECK (trigger_type IN ('per_count', 'threshold_once')),
  invite_count_step    INTEGER,
  threshold_count      INTEGER,
  reward_duration_days INTEGER NOT NULL CHECK (reward_duration_days > 0),
  reward_plan_id       VARCHAR(50) REFERENCES plans(id) ON DELETE SET NULL,
  max_reward_times     INTEGER,
  sort_order           INTEGER NOT NULL DEFAULT 0,
  is_active            BOOLEAN NOT NULL DEFAULT TRUE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (trigger_type = 'per_count' AND invite_count_step IS NOT NULL AND invite_count_step > 0)
    OR
    (trigger_type = 'threshold_once' AND threshold_count IS NOT NULL AND threshold_count > 0)
  ),
  CHECK (max_reward_times IS NULL OR max_reward_times > 0)
);

CREATE INDEX IF NOT EXISTS idx_invite_reward_policies_active_sort
  ON invite_reward_policies(is_active, sort_order, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_invite_reward_policies_trigger_type
  ON invite_reward_policies(trigger_type, created_at DESC);

CREATE TABLE IF NOT EXISTS invite_reward_grants (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  policy_id            UUID NOT NULL REFERENCES invite_reward_policies(id) ON DELETE CASCADE,
  subscription_id      UUID NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  reward_plan_id       VARCHAR(50) REFERENCES plans(id) ON DELETE SET NULL,
  reward_duration_days INTEGER NOT NULL CHECK (reward_duration_days > 0),
  trigger_invited_count INTEGER NOT NULL CHECK (trigger_invited_count > 0),
  status               VARCHAR(32) NOT NULL DEFAULT 'granted',
  granted_by           VARCHAR(100),
  note                 TEXT,
  granted_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, policy_id, trigger_invited_count)
);

CREATE INDEX IF NOT EXISTS idx_invite_reward_grants_user_created
  ON invite_reward_grants(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_invite_reward_grants_policy_created
  ON invite_reward_grants(policy_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_invite_reward_grants_status_created
  ON invite_reward_grants(status, created_at DESC);
