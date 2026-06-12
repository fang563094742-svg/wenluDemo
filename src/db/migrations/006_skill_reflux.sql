-- 006 技能反哺（skill-reflux）增量迁移
--
-- 归属边界：capability-pool 两套基础 DDL 的统一已由 multiuser-pg-store Req 8 落地
-- （见 004_capability_unify.sql，已对真实 PG 验证）。本迁移**不重复统一 capability-pool**，
-- 只在统一后的权威 schema 之上**仅新增**技能反哺所需的表/列。
--
-- 幂等保证（Req 1.4）：全部 CREATE TABLE IF NOT EXISTS / ALTER ... ADD COLUMN IF NOT EXISTS /
-- CREATE INDEX IF NOT EXISTS，第二次应用不改变数据库状态。本迁移由 pool.ts 的 initSchema
-- 在单个事务内执行（见 2.4），任一步抛错即整体 ROLLBACK，绝不半截写入（Req 1.5）。
--
-- 平台值归一（Req 1.2/1.4）：旧平台值 win32→win、darwin→mac（与 SkillPlatform 对齐）。
-- 迁移侧在写入新约束前先归一既有数据；读路径侧归一见 src/db/platformNormalize.ts。

-- ── 公共技能库 skill（与 skill-flywheel SkillSpec 对齐：值/结构分离 exec、taxonomy、provenance）──
CREATE TABLE IF NOT EXISTS skill (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            TEXT NOT NULL CHECK (kind IN ('soft','executable')),
  title           TEXT NOT NULL,
  description     TEXT NOT NULL,
  applicable_scenario TEXT,
  -- 值/结构分离执行体（对齐 SkillSpec.exec）：vars 列出占位变量，steps 仅保留结构（args 值用 ${var} 占位）
  exec_vars       TEXT[] NOT NULL DEFAULT '{}',
  exec_steps      JSONB NOT NULL DEFAULT '[]',     -- [{op, args:{a1:"${var}"}}]；soft 为平台中立步骤描述
  -- 多维分类（对齐 SkillSpec.taxonomy）
  taxonomy        JSONB NOT NULL DEFAULT '{"taskType":"generic"}', -- {industry?, app?, taskType}
  category        TEXT NOT NULL DEFAULT 'general',
  tags            TEXT[] NOT NULL DEFAULT '{}',
  platform        TEXT[] NOT NULL DEFAULT '{any}', -- 顶层平台契约(对齐 SkillSpec.platform)，取值 mac/win/linux/any
  os_scope        TEXT NOT NULL DEFAULT 'any',     -- 'any'(soft) | 'variant'(executable)
  source          TEXT NOT NULL DEFAULT 'self_learned'
                    CHECK (source IN ('user_taught','self_learned','admin_seeded')),
  user_neutral    BOOLEAN NOT NULL DEFAULT TRUE,   -- R18：是否用户中立
  is_starter      BOOLEAN NOT NULL DEFAULT FALSE,  -- R17：是否纳入 Starter
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
  version         INT NOT NULL DEFAULT 1,
  -- 来源信誉（对齐 SkillSpec.provenance）：与下方质量分为同一事实的两种视图
  provenance      JSONB NOT NULL DEFAULT '{}',     -- {createdAt, verifiedCount, totalCount}
  use_count       INT NOT NULL DEFAULT 0,          -- = provenance.totalCount
  success_count   INT NOT NULL DEFAULT 0,          -- = provenance.verifiedCount
  success_rate    REAL NOT NULL DEFAULT 0.0,       -- = success_count/use_count = reputationOf
  cross_user_breadth INT NOT NULL DEFAULT 0,
  silent_count    INT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  retired_at      TIMESTAMPTZ
);

-- skill 扩展字段补齐（IF NOT EXISTS 幂等）：若历史上已存在一个精简版 skill 表，
-- 此处把反哺所需扩展字段逐列补齐，保证与上面权威定义对齐、且二次应用不改变状态。
ALTER TABLE skill ADD COLUMN IF NOT EXISTS kind                TEXT;
ALTER TABLE skill ADD COLUMN IF NOT EXISTS applicable_scenario TEXT;
ALTER TABLE skill ADD COLUMN IF NOT EXISTS exec_vars           TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE skill ADD COLUMN IF NOT EXISTS exec_steps          JSONB NOT NULL DEFAULT '[]';
ALTER TABLE skill ADD COLUMN IF NOT EXISTS taxonomy            JSONB NOT NULL DEFAULT '{"taskType":"generic"}';
ALTER TABLE skill ADD COLUMN IF NOT EXISTS category            TEXT NOT NULL DEFAULT 'general';
ALTER TABLE skill ADD COLUMN IF NOT EXISTS tags                TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE skill ADD COLUMN IF NOT EXISTS platform            TEXT[] NOT NULL DEFAULT '{any}';
ALTER TABLE skill ADD COLUMN IF NOT EXISTS os_scope            TEXT NOT NULL DEFAULT 'any';
ALTER TABLE skill ADD COLUMN IF NOT EXISTS source              TEXT NOT NULL DEFAULT 'self_learned';
ALTER TABLE skill ADD COLUMN IF NOT EXISTS user_neutral        BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE skill ADD COLUMN IF NOT EXISTS is_starter          BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE skill ADD COLUMN IF NOT EXISTS status              TEXT NOT NULL DEFAULT 'active';
ALTER TABLE skill ADD COLUMN IF NOT EXISTS version             INT NOT NULL DEFAULT 1;
ALTER TABLE skill ADD COLUMN IF NOT EXISTS provenance          JSONB NOT NULL DEFAULT '{}';
ALTER TABLE skill ADD COLUMN IF NOT EXISTS use_count           INT NOT NULL DEFAULT 0;
ALTER TABLE skill ADD COLUMN IF NOT EXISTS success_count       INT NOT NULL DEFAULT 0;
ALTER TABLE skill ADD COLUMN IF NOT EXISTS success_rate        REAL NOT NULL DEFAULT 0.0;
ALTER TABLE skill ADD COLUMN IF NOT EXISTS cross_user_breadth  INT NOT NULL DEFAULT 0;
ALTER TABLE skill ADD COLUMN IF NOT EXISTS silent_count        INT NOT NULL DEFAULT 0;
ALTER TABLE skill ADD COLUMN IF NOT EXISTS retired_at          TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_skill_status_cat ON skill(status, category);
CREATE INDEX IF NOT EXISTS idx_skill_starter ON skill(is_starter) WHERE status='active';

-- ── 可执行技能的平台变体（os 统一枚举 mac/win/linux，与 SkillPlatform 对齐）──
CREATE TABLE IF NOT EXISTS skill_platform_variant (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_id        UUID NOT NULL REFERENCES skill(id) ON DELETE CASCADE,
  os              TEXT NOT NULL CHECK (os IN ('mac','win','linux')),
  command         TEXT NOT NULL,
  verify_status   TEXT NOT NULL DEFAULT 'unverified'
                    CHECK (verify_status IN ('unverified','server-verified','connector-verified')),
  verified_at     TIMESTAMPTZ,
  verified_by     TEXT,                           -- 验证来源连接器标识
  fail_streak     INT NOT NULL DEFAULT 0,         -- 连续失败计数(降级用)
  UNIQUE(skill_id, os)
);

-- ── 候选（管线状态机）──
CREATE TABLE IF NOT EXISTS skill_candidate (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            TEXT NOT NULL CHECK (kind IN ('soft','executable')),
  draft           JSONB NOT NULL,                 -- 蒸馏后草稿(title/desc/steps/intent…)
  category        TEXT,
  source_role     TEXT NOT NULL CHECK (source_role IN ('truth_gate','executable_seed','soft_seed')),
  source_weight   TEXT NOT NULL CHECK (source_weight IN ('user_task','autonomous')),
  user_neutral    BOOLEAN,
  status          TEXT NOT NULL DEFAULT 'seeded'
                    CHECK (status IN ('seeded','evidence_pending','proven','pending_review','rejected','suspect_duplicate')),
  contributor_id  UUID,
  linked_prediction_id   TEXT,
  linked_verifiable_id   TEXT,
  trajectory_ref  JSONB,
  contributor_reuse_success INT NOT NULL DEFAULT 0, -- 贡献方自身复用成功次数(未 active 前)
  merged_into     UUID REFERENCES skill(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_candidate_status ON skill_candidate(status);

-- ── 采集打标入队（原始信号，待蒸馏）──
CREATE TABLE IF NOT EXISTS skill_harvest_queue (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  signal_role     TEXT NOT NULL CHECK (signal_role IN ('truth_gate','executable_seed','soft_seed')),
  source_tool     TEXT NOT NULL,
  source_weight   TEXT NOT NULL CHECK (source_weight IN ('user_task','autonomous')),
  contributor_id  UUID NOT NULL,
  payload         JSONB NOT NULL,
  linked_prediction_id  TEXT,
  linked_verifiable_id  TEXT,
  task_id         TEXT,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','distilled','rejected')),
  enqueued_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_harvest_pending ON skill_harvest_queue(status, enqueued_at) WHERE status='pending';

-- ── 贡献者（跨用户广度）──
CREATE TABLE IF NOT EXISTS skill_contributor (
  skill_id        UUID NOT NULL REFERENCES skill(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL,
  original_title  TEXT,
  contributed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (skill_id, user_id)                 -- 同一用户对同一技能只计一次
);

-- ── 用户继承关系（替代 user_capabilities / capability_inheritances）──
CREATE TABLE IF NOT EXISTS user_skill (
  user_id         UUID NOT NULL,
  skill_id        UUID NOT NULL REFERENCES skill(id) ON DELETE CASCADE,
  enabled         BOOLEAN NOT NULL DEFAULT TRUE,  -- 用户可关闭(R17.8)
  personal_note   TEXT,
  acquired_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at    TIMESTAMPTZ,                    -- 静默检测(R12.4)
  PRIMARY KEY (user_id, skill_id)
);
CREATE INDEX IF NOT EXISTS idx_user_skill_user ON user_skill(user_id);

-- ── 轨迹环形缓冲：append-only 明细表（ADR-3）──
CREATE TABLE IF NOT EXISTS trajectory_event (
  id              BIGSERIAL PRIMARY KEY,
  user_id         UUID NOT NULL,
  cycle           INT,
  task_id         TEXT,
  action_name     TEXT NOT NULL,
  args_summary    TEXT,
  result_summary  TEXT,
  ts              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_traj_user_ts ON trajectory_event(user_id, ts DESC);

-- ── 技能/命令调用事件：反向点亮(R9.10) + 静默检测(R12)──
CREATE TABLE IF NOT EXISTS skill_invocation_event (
  id              BIGSERIAL PRIMARY KEY,
  user_id         UUID NOT NULL,
  skill_id        UUID REFERENCES skill(id) ON DELETE SET NULL,
  candidate_id    UUID REFERENCES skill_candidate(id) ON DELETE SET NULL,
  command_fingerprint TEXT,
  task_id         TEXT,
  platform        TEXT,
  outcome         TEXT NOT NULL DEFAULT 'pending' CHECK (outcome IN ('pending','success','fail')),
  invoked_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_invoke_skill ON skill_invocation_event(skill_id, outcome);
CREATE INDEX IF NOT EXISTS idx_invoke_candidate ON skill_invocation_event(candidate_id, outcome);

-- ── 冷启动继承幂等 + 补继承状态(R17)──
CREATE TABLE IF NOT EXISTS onboarding_state (
  user_id         UUID PRIMARY KEY,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','soft_done','completed')),
  platform        TEXT,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ
);

-- ── 平台渲染提示模板库(R15.13)──
CREATE TABLE IF NOT EXISTS render_hint_template (
  os              TEXT PRIMARY KEY CHECK (os IN ('mac','win','linux')),
  template        TEXT NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── 平台值归一 + 冲突检测（Req 1.2/1.4/1.5）──
-- 在新增的反哺表上，先把历史遗留的旧平台值 win32→win、darwin→mac 归一，
-- 再检测仍与新约束（os∈mac/win/linux、platform 元素∈mac/win/linux/any）冲突的记录：
-- 一旦发现冲突即 RAISE EXCEPTION 列出冲突表/列/记录并中止；因本迁移在事务内执行，
-- 中止即整体 ROLLBACK，绝不半截写入。
DO $$
DECLARE
  bad RECORD;
  conflicts TEXT := '';
BEGIN
  -- 1) 归一 skill_platform_variant.os 中的旧值（若历史数据存在）。
  --    注意：os 列带 CHECK(mac/win/linux)，若旧表是在无该约束时建的，仍可能含 win32/darwin。
  --    先尝试归一；归一后若仍非法则进入下方冲突检测。
  IF to_regclass('public.skill_platform_variant') IS NOT NULL THEN
    BEGIN
      UPDATE skill_platform_variant SET os = 'win'  WHERE os = 'win32';
      UPDATE skill_platform_variant SET os = 'mac'  WHERE os = 'darwin';
    EXCEPTION WHEN check_violation THEN
      -- 约束本身阻止写入旧值的情形：保持原状，交由下方检测统一报错。
      NULL;
    END;

    FOR bad IN
      SELECT id, os FROM skill_platform_variant
      WHERE os NOT IN ('mac','win','linux')
    LOOP
      conflicts := conflicts || format(E'\n  skill_platform_variant(id=%s, os=%L)', bad.id, bad.os);
    END LOOP;
  END IF;

  -- 2) 归一 skill.platform[] 数组中的旧值，并检测残留非法值。
  IF to_regclass('public.skill') IS NOT NULL THEN
    UPDATE skill
       SET platform = (
         SELECT array_agg(
           CASE elem WHEN 'win32' THEN 'win' WHEN 'darwin' THEN 'mac' ELSE elem END
         )
         FROM unnest(platform) AS elem
       )
     WHERE platform && ARRAY['win32','darwin']::text[];

    FOR bad IN
      SELECT id, platform FROM skill
      WHERE EXISTS (
        SELECT 1 FROM unnest(platform) AS elem
        WHERE elem NOT IN ('mac','win','linux','any')
      )
    LOOP
      conflicts := conflicts || format(E'\n  skill(id=%s, platform=%L)', bad.id, bad.platform);
    END LOOP;
  END IF;

  IF conflicts <> '' THEN
    RAISE EXCEPTION '006_skill_reflux 增量迁移中止：检测到旧数据与新平台约束冲突，未做任何写入。冲突记录：%', conflicts;
  END IF;
END $$;
