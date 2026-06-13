-- 004 capability-pool schema 统一（Requirement 8）
-- 现状分裂：002 建的 capability_pool 用 title/category/source/usage_count + user_capabilities/capability_submissions；
-- 而运行时 repo.ts 期望 name/command/steps/contributor_count + capability_contributions/capability_inheritances。
-- 本迁移把两套并入单一权威定义：以 repo.ts 运行所需为准，列取并集；旧数据保留。

-- ── capability_pool 列补齐（IF NOT EXISTS 幂等，与 002 的列并存）──
ALTER TABLE capability_pool ADD COLUMN IF NOT EXISTS name             TEXT;
ALTER TABLE capability_pool ADD COLUMN IF NOT EXISTS command          TEXT;
ALTER TABLE capability_pool ADD COLUMN IF NOT EXISTS steps            JSONB NOT NULL DEFAULT '[]';
ALTER TABLE capability_pool ADD COLUMN IF NOT EXISTS builds_on        JSONB NOT NULL DEFAULT '[]';
ALTER TABLE capability_pool ADD COLUMN IF NOT EXISTS auto_review      JSONB;
ALTER TABLE capability_pool ADD COLUMN IF NOT EXISTS contributed_by   UUID;
ALTER TABLE capability_pool ADD COLUMN IF NOT EXISTS contributor_count INT NOT NULL DEFAULT 0;
ALTER TABLE capability_pool ADD COLUMN IF NOT EXISTS inherit_count    INT NOT NULL DEFAULT 0;
ALTER TABLE capability_pool ADD COLUMN IF NOT EXISTS use_count        INT NOT NULL DEFAULT 0;
ALTER TABLE capability_pool ADD COLUMN IF NOT EXISTS success_count    INT NOT NULL DEFAULT 0;
ALTER TABLE capability_pool ADD COLUMN IF NOT EXISTS review_note      TEXT;

-- title/description 原为 NOT NULL（002）；repo.ts 以 name 为主、不写 title，故放开 NOT NULL。
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'capability_pool'
      AND column_name = 'title'
  ) THEN
    EXECUTE 'ALTER TABLE capability_pool ALTER COLUMN title DROP NOT NULL';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'capability_pool'
      AND column_name = 'description'
  ) THEN
    EXECUTE 'ALTER TABLE capability_pool ALTER COLUMN description DROP NOT NULL';
  END IF;
END $$;

-- status 原为 review_status ENUM（pending/approved/rejected），不含 repo.ts 用的 'auto_approved'。
-- 改为 TEXT，避免 ENUM 在事务内 ADD VALUE 的限制，并兼容 repo.ts 全部取值。
ALTER TABLE capability_pool ALTER COLUMN status DROP DEFAULT;
ALTER TABLE capability_pool ALTER COLUMN status TYPE TEXT USING status::text;
ALTER TABLE capability_pool ALTER COLUMN status SET DEFAULT 'pending';

CREATE INDEX IF NOT EXISTS idx_cap_pool_name ON capability_pool(name);

-- ── 贡献关系表（repo.ts 在用；跨用户广度计数）──
CREATE TABLE IF NOT EXISTS capability_contributions (
  capability_id    UUID NOT NULL REFERENCES capability_pool(id) ON DELETE CASCADE,
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  original_name    TEXT,
  original_command TEXT,
  contributed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (capability_id, user_id)
);

-- ── 继承关系表（repo.ts 在用；幂等 ON CONFLICT）──
CREATE TABLE IF NOT EXISTS capability_inheritances (
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  capability_id  UUID NOT NULL REFERENCES capability_pool(id) ON DELETE CASCADE,
  acquired_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, capability_id)
);
CREATE INDEX IF NOT EXISTS idx_cap_inherit_user ON capability_inheritances(user_id);

-- 旧数据保留：002 的 capability_pool 行（title 等）仍在；user_capabilities/capability_submissions 保留不动。
-- 若旧 capability_pool 有数据且 name 为空，用 title 回填 name，保证 repo.ts 按 name 查得到。
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'capability_pool'
      AND column_name = 'title'
  ) THEN
    EXECUTE 'UPDATE capability_pool SET name = title WHERE name IS NULL AND title IS NOT NULL';
  END IF;
END $$;
