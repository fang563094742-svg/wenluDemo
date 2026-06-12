-- 新增账号密码认证字段
ALTER TABLE users ADD COLUMN IF NOT EXISTS username VARCHAR(32);
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username
  ON users(username)
  WHERE username IS NOT NULL;
