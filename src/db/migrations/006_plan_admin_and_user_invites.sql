-- 邀请体系闭环 + 套餐后台可配置字段

ALTER TABLE users ADD COLUMN IF NOT EXISTS invite_code VARCHAR(20);
ALTER TABLE users ADD COLUMN IF NOT EXISTS invited_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS invited_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_invite_code
  ON users(invite_code)
  WHERE invite_code IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_users_invited_by_user
  ON users(invited_by_user_id)
  WHERE invited_by_user_id IS NOT NULL;

ALTER TABLE plans ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE plans ADD COLUMN IF NOT EXISTS badge_text VARCHAR(100);
ALTER TABLE plans ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE plans ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;

UPDATE plans
   SET description = COALESCE(description, CASE id
     WHEN 'free' THEN '适合新用户试用，含基础额度与体验期限制。'
     WHEN 'member' THEN '1天体验会员，适合临时高频使用。'
     WHEN 'monthly' THEN '30天会员，适合稳定持续使用。'
     WHEN 'yearly' THEN '永久会员，适合长期重度使用。'
     ELSE NULL
   END),
       badge_text = COALESCE(badge_text, CASE id
     WHEN 'free' THEN '试用'
     WHEN 'member' THEN '日卡'
     WHEN 'monthly' THEN '月卡'
     WHEN 'yearly' THEN '永久'
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
