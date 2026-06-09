-- 能力共享池 —— 记录问路 AI 在所有用户身上习得的有价值能力
-- 每条能力经审核后进入公共池，新用户注册时自动继承

-- 能力来源类型：user_taught（用户教的）、self_learned（自主学会的）、admin_seeded（管理员初始化的）
CREATE TYPE capability_source AS ENUM ('user_taught', 'self_learned', 'admin_seeded');

-- 审核状态
CREATE TYPE review_status AS ENUM ('pending', 'approved', 'rejected');

-- 公共能力池（全局唯一，审核后的能力会合并到这里）
CREATE TABLE IF NOT EXISTS capability_pool (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 能力核心内容
  title         TEXT NOT NULL,                   -- 简短标题，如"识别用户情绪低落"
  description   TEXT NOT NULL,                   -- 详细描述：什么场景、怎么做、预期效果
  category      TEXT NOT NULL DEFAULT 'general', -- 分类标签：emotional/knowledge/behavior/skill
  -- 溯源
  source        capability_source NOT NULL DEFAULT 'self_learned',
  contributor_id UUID REFERENCES users(id) ON DELETE SET NULL,  -- 贡献者
  -- 质量指标
  usage_count   INT NOT NULL DEFAULT 0,          -- 被多少用户实际使用过
  success_rate  REAL NOT NULL DEFAULT 0.0,       -- 使用成功率 0~1
  -- 管理
  status        review_status NOT NULL DEFAULT 'pending',
  reviewer_note TEXT,                            -- 审核备注
  reviewed_at   TIMESTAMPTZ,
  reviewed_by   TEXT,                            -- 审核人标识
  -- 时间
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 用户-能力关系表：记录每个用户继承/拥有了哪些能力
CREATE TABLE IF NOT EXISTS user_capabilities (
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  capability_id UUID NOT NULL REFERENCES capability_pool(id) ON DELETE CASCADE,
  -- 用户对这个能力的个人化覆盖
  enabled       BOOLEAN NOT NULL DEFAULT true,   -- 用户可以关闭不想要的能力
  personal_note TEXT,                            -- 用户自己的备注
  acquired_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, capability_id)
);

-- 待审核队列：用户/系统提交的原始能力候选
CREATE TABLE IF NOT EXISTS capability_submissions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 提交内容
  title         TEXT NOT NULL,
  description   TEXT NOT NULL,
  category      TEXT NOT NULL DEFAULT 'general',
  source        capability_source NOT NULL DEFAULT 'self_learned',
  submitter_id  UUID REFERENCES users(id) ON DELETE SET NULL,
  -- 自动预审结果
  auto_score    REAL,                            -- AI 自动评分 0~1（安全性+有用性）
  auto_reason   TEXT,                            -- 自动评分理由
  -- 审核
  status        review_status NOT NULL DEFAULT 'pending',
  reviewer_note TEXT,
  reviewed_at   TIMESTAMPTZ,
  -- 如果通过，关联到 pool 里的记录
  merged_to     UUID REFERENCES capability_pool(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_cap_pool_status ON capability_pool(status);
CREATE INDEX IF NOT EXISTS idx_cap_pool_category ON capability_pool(category);
CREATE INDEX IF NOT EXISTS idx_user_cap_user ON user_capabilities(user_id);
CREATE INDEX IF NOT EXISTS idx_cap_sub_status ON capability_submissions(status);
