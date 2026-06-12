-- 管理员给单个用户延长会员 / 赠送额外业务次数

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS extra_business_message_credits INTEGER NOT NULL DEFAULT 0;
