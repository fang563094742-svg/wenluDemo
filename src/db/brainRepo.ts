/**
 * 问路 — BrainRepo：用户大脑（mind）按用户隔离存储。
 *
 * 大脑按访问模式存为分区 JSONB：每用户 brain 表一行，Mind 字段映射到 6 个 JSONB 列，
 * 保存时按「脏板块」只 UPDATE 变动列（不重写整脑）。所有读写经 withUser → RLS 隔离。
 *
 * 设计要点：
 *  - 与 riverMain 解耦：以泛型 Mind 对象（Record<string,unknown>）工作，字段→板块映射在此单一维护。
 *  - 往返保真：split→merge 后字段集合与值与原 Mind 一致（未知字段兜底进 core，绝不丢字段）。
 */

import { withUser } from "./pool.js";

/** 大脑分区板块。 */
export type BrainSection = "core" | "cognition" | "capability" | "tasks" | "riverbed" | "channels_meta";

export const BRAIN_SECTIONS: readonly BrainSection[] = [
  "core", "cognition", "capability", "tasks", "riverbed", "channels_meta",
];

/** 泛型 Mind：结构上与 riverMain 的 Mind 一致，但此处不强绑定其类型。 */
export type MindLike = Record<string, unknown>;

/**
 * Mind 字段 → 板块 的单一权威映射。
 * 未列出的字段在 split 时兜底归入 core（保证不丢字段、向前兼容新增字段）。
 */
const FIELD_TO_SECTION: Record<string, BrainSection> = {
  // core：标量 / 小对象 / 配置
  cycles: "core",
  lastAction: "core",
  userLastActiveAt: "core",
  metrics: "core",
  goal: "core",
  calibrationProfile: "core",
  egressHealth: "core",
  fallbackReplyPolicy: "core",
  lastCalibrationCycle: "core",
  forbiddenTopics: "core",
  schemaVersion: "core",
  cognitiveCore: "core",
  executionKernel: "core",
  sovereign: "core",
  skillFlywheel: "core",
  capabilityDebtBackfilledAt: "core",
  // cognition：判断/知识/对用户的理解/反思/预测
  beliefs: "cognition",
  knowledge: "cognition",
  userModel: "cognition",
  reflections: "cognition",
  predictions: "cognition",
  // capability：能力/规则/脚本/技能库/能力债
  masteredTools: "capability",
  rules: "capability",
  scripts: "capability",
  skillKB: "capability",
  capabilityDebts: "capability",
  // tasks：任务线/任务链/可验证任务/注意力账本
  tasks: "tasks",
  taskChains: "tasks",
  verifiableTasks: "tasks",
  attentionLedger: "tasks",
  // riverbed：14 域河床 / 承诺
  riverbed: "riverbed",
  commitments: "riverbed",
  // channels_meta：频道元信息 + 待裁决队列 + 遗留对话（消息体后续迁 conversation_message）
  channels: "channels_meta",
  pendingDecisions: "channels_meta",
  conversation: "channels_meta",
};

function sectionOf(field: string): BrainSection {
  return FIELD_TO_SECTION[field] ?? "core";
}

/** 把 Mind 拆成 6 个板块对象。 */
export function splitMind(mind: MindLike): Record<BrainSection, Record<string, unknown>> {
  const out: Record<BrainSection, Record<string, unknown>> = {
    core: {}, cognition: {}, capability: {}, tasks: {}, riverbed: {}, channels_meta: {},
  };
  for (const [k, v] of Object.entries(mind)) {
    out[sectionOf(k)][k] = v;
  }
  return out;
}

/** 把 6 个板块行合并回扁平 Mind 对象。 */
export function mergeMind(row: Record<BrainSection, Record<string, unknown> | null>): MindLike {
  const mind: MindLike = {};
  for (const section of BRAIN_SECTIONS) {
    const obj = row[section];
    if (obj && typeof obj === "object") {
      for (const [k, v] of Object.entries(obj)) mind[k] = v;
    }
  }
  return mind;
}

interface BrainRow {
  core: Record<string, unknown>;
  cognition: Record<string, unknown>;
  capability: Record<string, unknown>;
  tasks: Record<string, unknown>;
  riverbed: Record<string, unknown>;
  channels_meta: Record<string, unknown>;
}

/** 读取用户大脑；无行返回 null。 */
export async function loadBrain(userId: string): Promise<MindLike | null> {
  return withUser(userId, async (client) => {
    const r = await client.query<BrainRow>(
      "SELECT core, cognition, capability, tasks, riverbed, channels_meta FROM brain WHERE user_id = $1",
      [userId],
    );
    if (!r.rows[0]) return null;
    return mergeMind(r.rows[0] as unknown as Record<BrainSection, Record<string, unknown>>);
  });
}

/** 首次建行：把完整 Mind 写入 6 板块（upsert）。 */
export async function upsertInitialBrain(userId: string, mind: MindLike): Promise<void> {
  const s = splitMind(mind);
  await withUser(userId, async (client) => {
    await client.query(
      `INSERT INTO brain (user_id, core, cognition, capability, tasks, riverbed, channels_meta, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())
       ON CONFLICT (user_id) DO UPDATE SET
         core=$2, cognition=$3, capability=$4, tasks=$5, riverbed=$6, channels_meta=$7, updated_at=now()`,
      [
        userId,
        JSON.stringify(s.core), JSON.stringify(s.cognition), JSON.stringify(s.capability),
        JSON.stringify(s.tasks), JSON.stringify(s.riverbed), JSON.stringify(s.channels_meta),
      ],
    );
  });
}

/**
 * 按脏板块保存：只 UPDATE dirty 指定的列。dirty 为空集时兜底写全部板块（安全）。
 * 若该用户尚无行，则退化为 upsertInitialBrain。
 */
export async function saveBrainSections(
  userId: string,
  mind: MindLike,
  dirty: Set<BrainSection>,
): Promise<void> {
  const sections: BrainSection[] = dirty.size > 0
    ? BRAIN_SECTIONS.filter((s) => dirty.has(s))
    : [...BRAIN_SECTIONS];
  const s = splitMind(mind);

  await withUser(userId, async (client) => {
    // 确保行存在（首次保存）。
    const exists = await client.query("SELECT 1 FROM brain WHERE user_id = $1", [userId]);
    if (exists.rows.length === 0) {
      await client.query(
        `INSERT INTO brain (user_id, core, cognition, capability, tasks, riverbed, channels_meta, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now())
         ON CONFLICT (user_id) DO NOTHING`,
        [
          userId,
          JSON.stringify(s.core), JSON.stringify(s.cognition), JSON.stringify(s.capability),
          JSON.stringify(s.tasks), JSON.stringify(s.riverbed), JSON.stringify(s.channels_meta),
        ],
      );
      return;
    }
    // 拼装脏列 SET 子句。
    const setParts: string[] = [];
    const params: unknown[] = [userId];
    let idx = 2;
    for (const section of sections) {
      setParts.push(`${section} = $${idx}`);
      params.push(JSON.stringify(s[section]));
      idx++;
    }
    setParts.push("updated_at = now()");
    await client.query(
      `UPDATE brain SET ${setParts.join(", ")} WHERE user_id = $1`,
      params,
    );
  });
}
