-- 问路 PostgreSQL Schema
-- 用户/会话/付费/分享

-- 启用 UUID 扩展
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================================
-- 用户表
-- ============================================================================
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone         VARCHAR(20) UNIQUE,               -- 手机号（短信登录标识）
  username      VARCHAR(32) UNIQUE,               -- 用户名（账号密码登录标识）
  password_hash TEXT,                             -- 密码哈希
  nickname      VARCHAR(100),                     -- 昵称（可选）
  avatar_url    TEXT,                             -- 头像 URL（可选）
  extra_business_message_credits INTEGER NOT NULL DEFAULT 0, -- 管理员赠送的额外业务次数
  invite_code   VARCHAR(20),                      -- 用户自己的邀请码
  invited_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL, -- 邀请人
  invited_at    TIMESTAMPTZ,                      -- 绑定邀请时间
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 微信字段
ALTER TABLE users ADD COLUMN IF NOT EXISTS wechat_openid  VARCHAR(100);
ALTER TABLE users ADD COLUMN IF NOT EXISTS wechat_unionid VARCHAR(100);
ALTER TABLE users ADD COLUMN IF NOT EXISTS username      VARCHAR(32);
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS extra_business_message_credits INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS invite_code VARCHAR(20);
ALTER TABLE users ADD COLUMN IF NOT EXISTS invited_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS invited_at TIMESTAMPTZ;

-- 手机号不再是唯一必填（微信登录可能没手机号）
ALTER TABLE users ALTER COLUMN phone DROP NOT NULL;

-- 索引
CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username) WHERE username IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_wechat_openid ON users(wechat_openid) WHERE wechat_openid IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_invite_code ON users(invite_code) WHERE invite_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_invited_by_user ON users(invited_by_user_id) WHERE invited_by_user_id IS NOT NULL;

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
  description   TEXT,                              -- 套餐展示文案
  badge_text    VARCHAR(100),                      -- 前端/后台展示角标
  price_cents   INTEGER NOT NULL DEFAULT 0,        -- 单位：分
  duration_days INTEGER NOT NULL DEFAULT 0,        -- 有效期天数（0=永久）
  sort_order    INTEGER NOT NULL DEFAULT 0,        -- 展示排序
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,     -- 是否展示/可售
  features      JSONB NOT NULL DEFAULT '{}',       -- 功能配置
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE plans ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE plans ADD COLUMN IF NOT EXISTS badge_text VARCHAR(100);
ALTER TABLE plans ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE plans ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;

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
-- 会员订单 / 支付流水 / 权益发放
-- ============================================================================

CREATE TABLE IF NOT EXISTS membership_orders (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_no         VARCHAR(64) NOT NULL UNIQUE,
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id          VARCHAR(50) NOT NULL REFERENCES plans(id),
  order_type       VARCHAR(32) NOT NULL DEFAULT 'recharge',
  amount_cents     INTEGER NOT NULL,
  currency         VARCHAR(16) NOT NULL DEFAULT 'CNY',
  status           VARCHAR(32) NOT NULL DEFAULT 'pending', -- pending/paid/fulfilled/cancelled/review_required/expired
  payment_channel  VARCHAR(50),
  idempotency_key  VARCHAR(100),
  client_reference VARCHAR(100),
  title            VARCHAR(200),
  metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,
  review_status    VARCHAR(32) NOT NULL DEFAULT 'not_required', -- not_required/pending_review/approved/rejected
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
  status                  VARCHAR(32) NOT NULL DEFAULT 'pending', -- pending/success/failed/review_required/refunded
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
  source          VARCHAR(32) NOT NULL DEFAULT 'payment', -- payment/manual_review/admin
  grant_status    VARCHAR(32) NOT NULL DEFAULT 'active',
  starts_at       TIMESTAMPTZ NOT NULL,
  expires_at      TIMESTAMPTZ,
  granted_by      VARCHAR(100),
  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_membership_grants_user
  ON membership_grants(user_id, created_at DESC);

-- 免费额度 / 会员放开：按日计数的业务入口用量
CREATE TABLE IF NOT EXISTS membership_usage_counters (
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  resource_key VARCHAR(50) NOT NULL,
  usage_date   DATE NOT NULL,
  used_count   INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, resource_key, usage_date)
);

CREATE INDEX IF NOT EXISTS idx_membership_usage_counters_resource
  ON membership_usage_counters(resource_key, usage_date DESC);

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
-- 长期认证设备会话表
-- ============================================================================
CREATE TABLE IF NOT EXISTS auth_device_sessions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token_hash VARCHAR(128) NOT NULL UNIQUE,
  device_id          VARCHAR(128),
  device_name        VARCHAR(200),
  platform           VARCHAR(50),
  user_agent         TEXT,
  last_ip            VARCHAR(64),
  refresh_expires_at TIMESTAMPTZ NOT NULL,
  last_seen_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at         TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_auth_device_sessions_user
  ON auth_device_sessions(user_id, revoked_at, refresh_expires_at DESC);
CREATE INDEX IF NOT EXISTS idx_auth_device_sessions_device
  ON auth_device_sessions(user_id, device_id)
  WHERE device_id IS NOT NULL;

-- ============================================================================
-- 初始化套餐数据
-- ============================================================================
INSERT INTO plans (id, name, price_cents, duration_days, features) VALUES
  ('free',    '免费体验', 0,    0,   '{"max_sessions": 1, "max_messages_per_day": 10, "free_trial_days": 3, "features": ["basic_chat"]}'),
  ('member',  '会员', 300, 1, '{"max_sessions": -1, "max_messages_per_day": -1, "payment_goods_key": "erf4ee", "features": ["basic_chat", "deep_scan", "memory", "proactive"]}'),
  ('monthly', '月度会员', 2900, 30,  '{"max_sessions": 10, "max_messages_per_day": -1, "features": ["basic_chat", "deep_scan", "memory", "proactive"]}'),
  ('yearly',  '年度会员', 19900, 365, '{"max_sessions": -1, "max_messages_per_day": -1, "features": ["basic_chat", "deep_scan", "memory", "proactive", "priority"]}')
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  price_cents = EXCLUDED.price_cents,
  duration_days = EXCLUDED.duration_days,
  features = EXCLUDED.features;

UPDATE plans
   SET description = COALESCE(description, CASE id
     WHEN 'free' THEN '适合新用户试用，含基础额度与体验期限制。'
     WHEN 'member' THEN '短期体验会员，适合临时高频使用。'
     WHEN 'monthly' THEN '按月开通，适合稳定持续使用。'
     WHEN 'yearly' THEN '全年会员，适合长期重度使用。'
     ELSE NULL
   END),
       badge_text = COALESCE(badge_text, CASE id
     WHEN 'free' THEN '试用'
     WHEN 'member' THEN '日卡'
     WHEN 'monthly' THEN '月付'
     WHEN 'yearly' THEN '年付'
     ELSE NULL
   END),
       sort_order = CASE id
     WHEN 'free' THEN 0
     WHEN 'member' THEN 10
     WHEN 'monthly' THEN 20
     WHEN 'yearly' THEN 30
     ELSE sort_order
   END,
       is_active = COALESCE(is_active, TRUE)
 WHERE id IN ('free', 'member', 'monthly', 'yearly');
