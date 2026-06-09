-- 能力共享池 Schema（追加到主 schema 之后执行）

-- ============================================================================
-- 公共能力池：所有用户共享的已审核通用能力
-- ============================================================================
CREATE TABLE IF NOT EXISTS capability_pool (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 能力基本信息（来自 masteredTools 的结构）
  name          VARCHAR(200) NOT NULL UNIQUE,       -- 能力名称（去重 key）
  description   TEXT NOT NULL,                      -- 能力描述
  command       TEXT NOT NULL,                      -- 底层命令模板
  steps         JSONB NOT NULL DEFAULT '[]',        -- 组合步骤（原 forgeSteps）
  builds_on     JSONB NOT NULL DEFAULT '[]',        -- 依赖的基础能力名列表

  -- 审核状态机：pending → auto_approved / rejected / approved
  status        VARCHAR(30) NOT NULL DEFAULT 'pending',
  -- 自动预审结果
  auto_review   JSONB DEFAULT NULL,                 -- { safe: bool, executable: bool, reason: string }
  -- 人工审核
  reviewed_by   VARCHAR(100),                       -- 审核人标识
  reviewed_at   TIMESTAMPTZ,
  review_note   TEXT,

  -- 来源追踪
  contributed_by UUID NOT NULL REFERENCES users(id),  -- 第一个锻造出该能力的用户
  contributor_count INTEGER NOT NULL DEFAULT 1,       -- 独立锻造出同名/同效果能力的用户数
  -- 当 contributor_count >= 3 且 auto_review.safe=true 时可自动晋升

  -- 使用统计
  inherit_count INTEGER NOT NULL DEFAULT 0,          -- 被多少用户继承
  use_count     INTEGER NOT NULL DEFAULT 0,          -- 累计被使用次数
  success_count INTEGER NOT NULL DEFAULT 0,          -- 累计成功次数

  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_capability_pool_status ON capability_pool(status);
CREATE INDEX IF NOT EXISTS idx_capability_pool_name ON capability_pool(name);

-- ============================================================================
-- 能力贡献记录：记录哪些用户独立锻造了同一能力
-- ============================================================================
CREATE TABLE IF NOT EXISTS capability_contributions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  capability_id UUID NOT NULL REFERENCES capability_pool(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 该用户锻造时的原始数据（保留证据）
  original_name VARCHAR(200) NOT NULL,
  original_command TEXT NOT NULL,
  forged_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(capability_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_cap_contrib_capability ON capability_contributions(capability_id);
CREATE INDEX IF NOT EXISTS idx_cap_contrib_user ON capability_contributions(user_id);

-- ============================================================================
-- 用户能力继承记录：谁从公共池继承了什么
-- ============================================================================
CREATE TABLE IF NOT EXISTS capability_inheritances (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  capability_id UUID NOT NULL REFERENCES capability_pool(id) ON DELETE CASCADE,
  inherited_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, capability_id)
);

CREATE INDEX IF NOT EXISTS idx_cap_inherit_user ON capability_inheritances(user_id);
