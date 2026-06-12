-- 免费次数 / 限时逻辑：为真实业务入口记录每日使用次数

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
