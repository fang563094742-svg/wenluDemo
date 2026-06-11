-- 003 多用户大脑存储：System_User seed + 大脑/记忆/器官/对话表 + 只读投影骨架
-- 全部以 user_id 为隔离维度。配套 RLS 见 005_rls.sql。

-- ── System_User（local）：固定哨兵 UUID，承载迁移期单份全局大脑（ADR-1）──
INSERT INTO users (id, nickname)
VALUES ('00000000-0000-0000-0000-000000000000', 'local')
ON CONFLICT (id) DO NOTHING;

-- ── 大脑主表：每用户一行，Mind 按板块切成 6 个 JSONB 列；脏板块只 UPDATE 变动列 ──
CREATE TABLE IF NOT EXISTS brain (
  user_id       UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  core          JSONB NOT NULL DEFAULT '{}',  -- cycles/lastAction/userLastActiveAt/metrics/goal/
                                              --   calibrationProfile/egressHealth/fallbackReplyPolicy/
                                              --   lastCalibrationCycle/forbiddenTopics/schemaVersion/
                                              --   cognitiveCore/executionKernel/sovereign/skillFlywheel/
                                              --   capabilityDebtBackfilledAt
  cognition     JSONB NOT NULL DEFAULT '{}',  -- beliefs/knowledge/userModel/reflections/predictions
  capability    JSONB NOT NULL DEFAULT '{}',  -- masteredTools/rules/scripts/skillKB/capabilityDebts
  tasks         JSONB NOT NULL DEFAULT '{}',  -- tasks/taskChains/verifiableTasks/attentionLedger
  riverbed      JSONB NOT NULL DEFAULT '{}',  -- riverbed(14域)/commitments
  channels_meta JSONB NOT NULL DEFAULT '{}',  -- channels 元信息(标题/游标/归档/系统频道)+pendingDecisions（不含消息体）
  version       INT  NOT NULL DEFAULT 1,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── 对话权威表：append-only，按 user_id + channel_id 隔离（消息体从 JSONB 移出）──
CREATE TABLE IF NOT EXISTS conversation_message (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id  TEXT NOT NULL,
  role        TEXT NOT NULL,                  -- user | wenlu | system
  text        TEXT NOT NULL,
  metadata    JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_conv_user_channel_ts
  ON conversation_message(user_id, channel_id, created_at DESC);

-- ── 分层记忆：每用户一行，板块=列 ──
CREATE TABLE IF NOT EXISTS memory (
  user_id     UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  working     JSONB NOT NULL DEFAULT '{}',
  episodic    JSONB NOT NULL DEFAULT '[]',
  semantic    JSONB NOT NULL DEFAULT '[]',
  procedural  JSONB NOT NULL DEFAULT '{}',
  meta        JSONB NOT NULL DEFAULT '{}',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── 器官状态（原 sensors/_state.json）──
CREATE TABLE IF NOT EXISTS sensor_state (
  user_id     UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  state       JSONB NOT NULL DEFAULT '{}',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── 只读投影骨架（本期仅建表，按需由消费方填充/重建）──
CREATE TABLE IF NOT EXISTS prediction_proj (
  user_id       UUID NOT NULL,
  prediction_id TEXT NOT NULL,
  status        TEXT,             -- open/hit/miss
  created_at    TIMESTAMPTZ,
  settled_at    TIMESTAMPTZ,
  PRIMARY KEY (user_id, prediction_id)
);

CREATE TABLE IF NOT EXISTS verifiable_task_proj (
  user_id       UUID NOT NULL,
  task_id       TEXT NOT NULL,
  status        TEXT,             -- open/passed/failed
  updated_at    TIMESTAMPTZ,
  PRIMARY KEY (user_id, task_id)
);
