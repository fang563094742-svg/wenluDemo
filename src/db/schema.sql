-- 问路 PostgreSQL Schema
-- 用户/会话/付费/分享

-- 启用 UUID 扩展
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================================
-- 用户表
-- ============================================================================
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone         VARCHAR(20) NOT NULL UNIQUE,      -- 手机号（唯一登录标识）
  nickname      VARCHAR(100),                      -- 昵称（可选）
  avatar_url    TEXT,                              -- 头像 URL（可选）
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 微信字段
ALTER TABLE users ADD COLUMN IF NOT EXISTS wechat_openid  VARCHAR(100);
ALTER TABLE users ADD COLUMN IF NOT EXISTS wechat_unionid VARCHAR(100);

-- 手机号不再是唯一必填（微信登录可能没手机号）
ALTER TABLE users ALTER COLUMN phone DROP NOT NULL;

-- 索引
CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_wechat_openid ON users(wechat_openid) WHERE wechat_openid IS NOT NULL;

-- ============================================================================
-- 验证码表（短信验证码临时存储）
-- ============================================================================
CREATE TABLE IF NOT EXISTS sms_codes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone         VARCHAR(20) NOT NULL,
  code          VARCHAR(6) NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,             -- 过期时间（5分钟后）
  used          BOOLEAN NOT NULL DEFAULT FALSE,    -- 是否已使用
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 按手机号+未使用+未过期查询
CREATE INDEX IF NOT EXISTS idx_sms_codes_phone ON sms_codes(phone, used, expires_at);

-- ============================================================================
-- 套餐/付费表
-- ============================================================================

-- 套餐定义
CREATE TABLE IF NOT EXISTS plans (
  id            VARCHAR(50) PRIMARY KEY,           -- e.g. 'free', 'monthly', 'yearly'
  name          VARCHAR(100) NOT NULL,             -- 展示名称
  price_cents   INTEGER NOT NULL DEFAULT 0,        -- 单位：分
  duration_days INTEGER NOT NULL DEFAULT 0,        -- 有效期天数（0=永久）
  features      JSONB NOT NULL DEFAULT '{}',       -- 功能配置
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 用户订阅（当前生效的套餐）
CREATE TABLE IF NOT EXISTS subscriptions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id       VARCHAR(50) NOT NULL REFERENCES plans(id),
  starts_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ,                       -- NULL 表示永不过期（free 套餐）
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_id, is_active);

-- 支付记录
CREATE TABLE IF NOT EXISTS payments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id       VARCHAR(50) NOT NULL REFERENCES plans(id),
  amount_cents  INTEGER NOT NULL,                  -- 实付金额（分）
  channel       VARCHAR(50) NOT NULL DEFAULT 'wechat', -- 支付渠道
  transaction_id VARCHAR(200),                     -- 第三方流水号
  status        VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending/success/failed/refunded
  paid_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id, created_at DESC);

-- ============================================================================
-- 会话表（每个用户可有多个对话）
-- ============================================================================
CREATE TABLE IF NOT EXISTS sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title         VARCHAR(200),                      -- 会话标题（自动生成或用户指定）
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, is_active, updated_at DESC);

-- ============================================================================
-- 消息表
-- ============================================================================
CREATE TABLE IF NOT EXISTS messages (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role          VARCHAR(20) NOT NULL,              -- 'user' | 'assistant' | 'system'
  content       TEXT NOT NULL,
  metadata      JSONB DEFAULT '{}',                -- 附加信息（情绪分析、工具调用等）
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);

-- ============================================================================
-- 分享邀请表（朋友圈体验卡机制）
-- ============================================================================
CREATE TABLE IF NOT EXISTS share_invites (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inviter_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invite_code   VARCHAR(20) NOT NULL UNIQUE,       -- 6-8位邀请码
  plan_id       VARCHAR(50) NOT NULL REFERENCES plans(id), -- 体验什么套餐
  duration_days INTEGER NOT NULL DEFAULT 3,        -- 体验天数
  max_uses      INTEGER NOT NULL DEFAULT 1,        -- 最大使用次数
  used_count    INTEGER NOT NULL DEFAULT 0,
  expires_at    TIMESTAMPTZ NOT NULL,              -- 邀请码过期时间
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_share_invites_code ON share_invites(invite_code);
CREATE INDEX IF NOT EXISTS idx_share_invites_inviter ON share_invites(inviter_id);

-- 邀请使用记录
CREATE TABLE IF NOT EXISTS share_redemptions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invite_id     UUID NOT NULL REFERENCES share_invites(id),
  redeemer_id   UUID NOT NULL REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(invite_id, redeemer_id)                   -- 同一邀请同一用户只能用一次
);

-- ============================================================================
-- 用户 mind 快照（持久化 mind.json，多用户隔离）
-- ============================================================================
CREATE TABLE IF NOT EXISTS user_minds (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE UNIQUE,
  mind_data     JSONB NOT NULL DEFAULT '{}',       -- mind.json 完整内容
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_minds_user ON user_minds(user_id);

-- ============================================================================
-- 初始化套餐数据
-- ============================================================================
INSERT INTO plans (id, name, price_cents, duration_days, features) VALUES
  ('free',    '免费体验', 0,    0,   '{"max_sessions": 1, "max_messages_per_day": 10, "features": ["basic_chat"]}'),
  ('monthly', '月度会员', 2900, 30,  '{"max_sessions": 10, "max_messages_per_day": 100, "features": ["basic_chat", "deep_scan", "memory", "proactive"]}'),
  ('yearly',  '年度会员', 19900, 365, '{"max_sessions": -1, "max_messages_per_day": -1, "features": ["basic_chat", "deep_scan", "memory", "proactive", "priority"]}')
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  price_cents = EXCLUDED.price_cents,
  duration_days = EXCLUDED.duration_days,
  features = EXCLUDED.features;
