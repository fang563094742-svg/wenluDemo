/**
 * 问路 — 能力共享池 Repository。
 *
 * 负责：
 *  - 能力提交（锻造后自动进入待审）
 *  - 自动预审（安全性+可执行性检查）
 *  - 贡献者计数 & 自动晋升
 *  - 用户继承公共能力
 *  - 管理员审核接口
 */

import { query, transaction } from "../db/pool.js";

// ─── 类型 ─────────────────────────────────────────────────────────────────────

export type CapabilityStatus = "pending" | "auto_approved" | "approved" | "rejected";

export interface CapabilityPoolRow {
  id: string;
  name: string;
  description: string;
  command: string;
  steps: any[];
  builds_on: string[];
  status: CapabilityStatus;
  auto_review: { safe: boolean; executable: boolean; reason: string } | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  contributed_by: string;
  contributor_count: number;
  inherit_count: number;
  use_count: number;
  success_count: number;
  created_at: string;
  updated_at: string;
}

export interface MasteredToolInput {
  name: string;
  description: string;
  command: string;
  steps?: any[];
  buildsOn?: string[];
}

// ─── 危险命令黑名单（自动预审用） ───────────────────────────────────────────────

const DANGEROUS_PATTERNS = [
  /\brm\s+(-rf?|--recursive)\s+[\/~]/i,   // rm -rf /
  /\bsudo\b/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /\b(curl|wget)\s+.*\|\s*(bash|sh|zsh)/i, // curl | bash
  /\bchmod\s+777/i,
  />\s*\/dev\/sd/i,
  /\bformat\b.*\b[a-z]:/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /DROP\s+(TABLE|DATABASE)/i,
  /TRUNCATE/i,
  /\beval\s*\(/i,
  /\bnc\s+.*-e/i,                          // netcat reverse shell
];

/** 检查命令是否安全（白名单思路：不含危险模式=安全）。 */
function isCommandSafe(command: string): { safe: boolean; reason: string } {
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      return { safe: false, reason: `命令匹配危险模式: ${pattern.source}` };
    }
  }
  return { safe: true, reason: "未匹配任何危险命令模式" };
}

/** 检查命令是否为可执行格式（基本语法检查）。 */
function isCommandExecutable(command: string): boolean {
  // 基本检查：非空 + 有实际命令内容
  const trimmed = command.trim();
  if (!trimmed || trimmed.length < 2) return false;
  // 必须有字母开头的命令（非纯特殊字符）
  return /^[a-zA-Z\/.]/.test(trimmed);
}

// ─── 核心操作 ─────────────────────────────────────────────────────────────────

/**
 * 提交能力到共享池。
 *
 * 逻辑：
 * 1. 如果同名能力已存在 → 记录为新贡献者，累加 contributor_count
 * 2. 如果不存在 → 创建新条目 + 自动预审
 * 3. 如果 contributor_count >= 3 且 auto_review.safe → 自动晋升为 auto_approved
 */
export async function submitCapability(
  userId: string,
  tool: MasteredToolInput,
): Promise<{ capabilityId: string; status: CapabilityStatus; isNew: boolean }> {
  return transaction(async (client) => {
    // 检查是否已存在同名能力
    const existing = await client.query(
      `SELECT id, contributor_count, status, auto_review FROM capability_pool WHERE name = $1`,
      [tool.name],
    );

    if (existing.rows.length > 0) {
      const cap = existing.rows[0];
      // 检查该用户是否已贡献过
      const alreadyContrib = await client.query(
        `SELECT 1 FROM capability_contributions WHERE capability_id = $1 AND user_id = $2`,
        [cap.id, userId],
      );
      if (alreadyContrib.rows.length === 0) {
        // 新贡献者
        await client.query(
          `INSERT INTO capability_contributions (capability_id, user_id, original_name, original_command)
           VALUES ($1, $2, $3, $4)`,
          [cap.id, userId, tool.name, tool.command],
        );
        const newCount = cap.contributor_count + 1;
        let newStatus = cap.status;

        // 自动晋升条件：≥3 贡献者 + 预审安全 + 当前还在 pending
        if (newCount >= 3 && cap.auto_review?.safe && cap.status === "pending") {
          newStatus = "auto_approved";
        }

        await client.query(
          `UPDATE capability_pool SET contributor_count = $1, status = $2, updated_at = NOW() WHERE id = $3`,
          [newCount, newStatus, cap.id],
        );
        return { capabilityId: cap.id, status: newStatus as CapabilityStatus, isNew: false };
      }
      return { capabilityId: cap.id, status: cap.status as CapabilityStatus, isNew: false };
    }

    // 新能力 — 自动预审
    const safetyCheck = isCommandSafe(tool.command);
    const executable = isCommandExecutable(tool.command);
    const autoReview = { safe: safetyCheck.safe, executable, reason: safetyCheck.reason };

    const result = await client.query(
      `INSERT INTO capability_pool (name, description, command, steps, builds_on, status, auto_review, contributed_by, contributor_count)
       VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, 1)
       RETURNING id`,
      [
        tool.name,
        tool.description || "",
        tool.command,
        JSON.stringify(tool.steps || []),
        JSON.stringify(tool.buildsOn || []),
        JSON.stringify(autoReview),
        userId,
      ],
    );
    const capId = result.rows[0].id;

    // 记录贡献
    await client.query(
      `INSERT INTO capability_contributions (capability_id, user_id, original_name, original_command)
       VALUES ($1, $2, $3, $4)`,
      [capId, userId, tool.name, tool.command],
    );

    return { capabilityId: capId, status: "pending" as CapabilityStatus, isNew: true };
  });
}

/**
 * 获取待审核能力列表（管理员用）。
 */
export async function getPendingCapabilities(): Promise<CapabilityPoolRow[]> {
  const res = await query<CapabilityPoolRow>(
    `SELECT * FROM capability_pool WHERE status = 'pending' ORDER BY contributor_count DESC, created_at ASC`,
  );
  return res.rows;
}

/**
 * 管理员审核通过/拒绝。
 */
export async function reviewCapability(
  capabilityId: string,
  decision: "approved" | "rejected",
  reviewedBy: string,
  note?: string,
): Promise<void> {
  await query(
    `UPDATE capability_pool
     SET status = $1, reviewed_by = $2, reviewed_at = NOW(), review_note = $3, updated_at = NOW()
     WHERE id = $4`,
    [decision, reviewedBy, note || null, capabilityId],
  );
}

/**
 * 获取所有可用的公共能力（approved 或 auto_approved）。
 */
export async function getApprovedCapabilities(): Promise<CapabilityPoolRow[]> {
  const res = await query<CapabilityPoolRow>(
    `SELECT * FROM capability_pool WHERE status IN ('approved', 'auto_approved') ORDER BY use_count DESC`,
  );
  return res.rows;
}

/**
 * 用户继承公共能力（记录继承关系 + 返回能力列表）。
 */
export async function inheritCapabilities(
  userId: string,
  capabilityIds?: string[],
): Promise<CapabilityPoolRow[]> {
  // 获取所有已审核通过的能力
  const approved = await getApprovedCapabilities();
  const toInherit = capabilityIds
    ? approved.filter((c) => capabilityIds.includes(c.id))
    : approved;

  for (const cap of toInherit) {
    // 幂等：ON CONFLICT 跳过
    await query(
      `INSERT INTO capability_inheritances (user_id, capability_id)
       VALUES ($1, $2) ON CONFLICT (user_id, capability_id) DO NOTHING`,
      [userId, cap.id],
    );
    // 更新继承计数
    await query(
      `UPDATE capability_pool SET inherit_count = inherit_count + 1, updated_at = NOW()
       WHERE id = $1 AND NOT EXISTS (
         SELECT 1 FROM capability_inheritances WHERE user_id = $2 AND capability_id = $1
       )`,
      [cap.id, userId],
    );
  }

  return toInherit;
}

/**
 * 记录能力使用（成功/失败），更新统计。
 */
export async function recordCapabilityUsage(
  capabilityId: string,
  success: boolean,
): Promise<void> {
  if (success) {
    await query(
      `UPDATE capability_pool SET use_count = use_count + 1, success_count = success_count + 1, updated_at = NOW() WHERE id = $1`,
      [capabilityId],
    );
  } else {
    await query(
      `UPDATE capability_pool SET use_count = use_count + 1, updated_at = NOW() WHERE id = $1`,
      [capabilityId],
    );
  }
}

/**
 * 获取用户已继承的能力列表。
 */
export async function getUserInheritedCapabilities(userId: string): Promise<CapabilityPoolRow[]> {
  const res = await query<CapabilityPoolRow>(
    `SELECT cp.* FROM capability_pool cp
     JOIN capability_inheritances ci ON ci.capability_id = cp.id
     WHERE ci.user_id = $1
     ORDER BY cp.name`,
    [userId],
  );
  return res.rows;
}

/**
 * 获取能力池统计信息。
 */
export async function getPoolStats(): Promise<{
  total: number;
  pending: number;
  approved: number;
  auto_approved: number;
  rejected: number;
  total_inherits: number;
  total_uses: number;
}> {
  const res = await query(`
    SELECT
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE status = 'pending') as pending,
      COUNT(*) FILTER (WHERE status = 'approved') as approved,
      COUNT(*) FILTER (WHERE status = 'auto_approved') as auto_approved,
      COUNT(*) FILTER (WHERE status = 'rejected') as rejected,
      COALESCE(SUM(inherit_count), 0) as total_inherits,
      COALESCE(SUM(use_count), 0) as total_uses
    FROM capability_pool
  `);
  const row = res.rows[0];
  return {
    total: Number(row.total),
    pending: Number(row.pending),
    approved: Number(row.approved),
    auto_approved: Number(row.auto_approved),
    rejected: Number(row.rejected),
    total_inherits: Number(row.total_inherits),
    total_uses: Number(row.total_uses),
  };
}

// ─── skill-reflux 扩展（治理并存：新增，不改既有 capability_pool 逻辑） ──────────────
//
// 说明（skill-reflux 任务 3）：二期云反哺以新 `skill` 表族（skill / user_skill /
// skill_platform_variant / skill_contributor）承载公共技能与跨用户继承。既有
// capability_pool 表族与上面所有函数**原样保留、继续生效**（治理并存）。
// 这里仅**新增** `inheritSkills`（读写 `user_skill`，对应既有 `inheritCapabilities`
// 在新表上的扩展）与 `recordSkillUsage`（更新 `skill` 质量字段 + `user_skill.last_used_at`，
// 对应既有 `recordCapabilityUsage` 在新表上的扩展），二者互不影响。
//
// 注意：`skill` / `user_skill` 表由 skill-reflux 增量迁移 006_skill_reflux.sql 建立，
// 本文件只写数据访问、不重复建表。
//
// _Requirements: skill-reflux 11.3, 12.1_

/** `skill` 表行（与 src/reflux/types.ts 的 Skill 对齐，此处仅取继承/回写所需列）。 */
export interface SkillRowLite {
  id: string;
  kind: string;
  title: string;
  description: string;
  category: string;
  tags: string[];
  platform: string[];
  os_scope: string;
  status: string;
  is_starter: boolean;
  user_neutral: boolean;
  use_count: number;
  success_count: number;
  success_rate: number;
  cross_user_breadth: number;
  created_at: string;
  updated_at: string;
}

/**
 * 用户继承公共技能（对应既有 `inheritCapabilities` 在 `skill`/`user_skill` 上的扩展）。
 *
 * 逻辑：取 active 公共技能（可按 skillIds 过滤），幂等写入 `user_skill`
 * （ON CONFLICT DO NOTHING，支持 `user_skill.enabled` 由用户关闭），返回被继承技能列表。
 * 与既有 `inheritCapabilities`（capability_pool / capability_inheritances）并存、互不影响。
 */
export async function inheritSkills(
  userId: string,
  skillIds?: string[],
): Promise<SkillRowLite[]> {
  const params: unknown[] = [];
  let where = `WHERE status = 'active'`;
  if (skillIds && skillIds.length > 0) {
    params.push(skillIds);
    where += ` AND id = ANY($${params.length})`;
  }
  const active = await query<SkillRowLite>(
    `SELECT id, kind, title, description, category, tags, platform, os_scope,
            status, is_starter, user_neutral, use_count, success_count, success_rate,
            cross_user_breadth, created_at, updated_at
       FROM skill ${where}`,
    params,
  );

  for (const s of active.rows) {
    // 幂等：同一 (user_id, skill_id) 只继承一次；enabled 默认 TRUE，可由用户关闭。
    await query(
      `INSERT INTO user_skill (user_id, skill_id)
       VALUES ($1, $2) ON CONFLICT (user_id, skill_id) DO NOTHING`,
      [userId, s.id],
    );
  }
  return active.rows;
}

/**
 * 记录公共技能复用（成功/失败），更新质量分 + 继承方最近使用时间
 * （对应既有 `recordCapabilityUsage` 在 `skill`/`user_skill` 上的扩展）。
 *
 * 更新（Req 12.1）：
 *  - `skill`：use_count(+1) / success_count(+成功?1:0) / success_rate / provenance（同一事实两视图）；
 *  - `user_skill.last_used_at`：该继承方最近使用时间（静默检测 Req 12.4 依据）。
 *
 * 与既有 `recordCapabilityUsage`（capability_pool）并存、互不影响。
 */
export async function recordSkillUsage(
  userId: string,
  skillId: string,
  success: boolean,
): Promise<void> {
  const inc = success ? 1 : 0;
  await transaction(async (client) => {
    await client.query(
      `UPDATE skill SET
         use_count = use_count + 1,
         success_count = success_count + $2,
         success_rate = (success_count + $2)::real / (use_count + 1)::real,
         provenance = jsonb_set(
           jsonb_set(
             COALESCE(provenance, '{}'::jsonb),
             '{totalCount}', to_jsonb((COALESCE((provenance->>'totalCount')::int, 0) + 1))
           ),
           '{verifiedCount}', to_jsonb((COALESCE((provenance->>'verifiedCount')::int, 0) + $2))
         ),
         updated_at = NOW()
       WHERE id = $1`,
      [skillId, inc],
    );
    // 继承方最近使用时间（仅当该用户确有继承关系时更新）。
    await client.query(
      `UPDATE user_skill SET last_used_at = NOW() WHERE user_id = $1 AND skill_id = $2`,
      [userId, skillId],
    );
  });
}
