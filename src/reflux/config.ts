/**
 * 技能反哺（Skill Reflux）· 可配置参数（config.ts）
 * ------------------------------------------------------------------
 * 集中维护反哺管线的可配置参数（对应 design.md「Configurable Parameters」表）。
 * 统一配置源：优先读环境变量，其次读 JSON 覆盖，最后落到设计建议默认值；
 * 运行期可读、变更即生效（不需改代码，见 ADR-4）。
 *
 * 时间类参数统一以**毫秒**存储（字段后缀 `_ms`），由各自的"天/小时/秒"默认值换算而来，
 * 便于与 `setInterval`/时间戳比较直接对齐。
 *
 * _Requirements: 1.2, 全局支撑；Configurable Parameters_
 */

// ── 时间换算常量 ──
const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * 反哺可配置参数集合。
 * 参数名与 design.md「Configurable Parameters」表一一对应（术语保留英文原文）。
 */
export interface RefluxConfig {
  // ── 反馈 / 静默 ──
  /** T_silent：静默继承判定窗口（默认 7 天）。调短→更快判静默、更易降分；调长→宽容。 */
  T_silent_ms: number;

  // ── 淘汰 ──
  /** Elimination_Window：淘汰观察窗口（默认 30 天）。调短→淘汰更激进；调长→更迟钝。 */
  Elimination_Window_ms: number;
  /** Elimination_Threshold：success_rate 低于此值触发淘汰（默认 0.5）。 */
  Elimination_Threshold: number;
  /** Min_Sample：触发淘汰所需最小 use_count（默认 5），避免小样本误判。 */
  Min_Sample: number;

  // ── 晋升 ──
  /** Promotion_Threshold_N（硬，可执行类）：复用成功次数阈值（默认 3）。 */
  Promotion_Threshold_N_hard: number;
  /** Promotion_Threshold_N（软，软性类）：因缺客观验证，独立配置为更高值（默认 5）。 */
  Promotion_Threshold_N_soft: number;
  /** High_Score：success_rate 高于此值视为高分（默认 0.8）。 */
  High_Score: number;

  // ── 冷启动 ──
  /** Starter_M：纳入 Starter_Skill_Set 的 Cross_User_Breadth 阈值（默认 3）。 */
  Starter_M: number;
  /** Starter_TopN：Starter_Skill_Set 的数量上限（由产品定，默认 20）。 */
  Starter_TopN: number;

  // ── 成本 / 蒸馏 ──
  /** Pipeline_LLM_Budget：单条反哺管线 LLM 调用次数上限（默认 5；分配：蒸馏≤2/去重≤2/软评审≤1）。 */
  Pipeline_LLM_Budget: number;
  /** B：单批蒸馏量（默认 20）。调高→单批 LLM 压力大；调低→吞吐低。 */
  B: number;
  /** DISTILL_MAX_INTERVAL：蒸馏兜底定时器最大间隔（默认 10 分钟）。 */
  DISTILL_MAX_INTERVAL_ms: number;

  // ── 去重 ──
  /** Dedup_K：软性类语义查重单次最多比对数（默认 10），避免 O(n²)。 */
  Dedup_K: number;

  // ── 轨迹 ──
  /** Traj_N：轨迹环形缓冲每用户保留最近条数（默认 50）。 */
  Traj_N: number;
  /** Traj_T：轨迹保留最近时间窗（默认 24 小时）。 */
  Traj_T_ms: number;

  // ── 分发 ──
  /** T4T5_Timeout：T4 救援/T5 查库检索超时（默认 5 秒）。超时视为未命中、不阻塞。 */
  T4T5_Timeout_ms: number;

  // ── 验证 ──
  /** Connector_Downgrade_Streak：connector-verified 变体连续失败降级阈值（默认 3）。 */
  Connector_Downgrade_Streak: number;
}

/** design.md「Configurable Parameters」表的建议默认值。 */
export const DEFAULT_REFLUX_CONFIG: RefluxConfig = {
  // 反馈 / 静默
  T_silent_ms: 7 * DAY_MS,
  // 淘汰
  Elimination_Window_ms: 30 * DAY_MS,
  Elimination_Threshold: 0.5,
  Min_Sample: 5,
  // 晋升
  Promotion_Threshold_N_hard: 3,
  Promotion_Threshold_N_soft: 5,
  High_Score: 0.8,
  // 冷启动
  Starter_M: 3,
  Starter_TopN: 20,
  // 成本 / 蒸馏
  Pipeline_LLM_Budget: 5,
  B: 20,
  DISTILL_MAX_INTERVAL_ms: 10 * MINUTE_MS,
  // 去重
  Dedup_K: 10,
  // 轨迹
  Traj_N: 50,
  Traj_T_ms: 24 * HOUR_MS,
  // 分发
  T4T5_Timeout_ms: 5 * SECOND_MS,
  // 验证
  Connector_Downgrade_Streak: 3,
};

/** 解析一个数值环境变量，非法/缺失时返回 undefined。 */
function envNum(name: string): number | undefined {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** 取第一个有定义的值（按优先级），全部 undefined 时返回默认值。 */
function pick<T>(def: T, ...candidates: Array<T | undefined>): T {
  for (const c of candidates) {
    if (c !== undefined) return c;
  }
  return def;
}

/**
 * 解析反哺配置：默认值 ← JSON 覆盖 ← 环境变量（环境变量优先级最高）。
 *
 * 环境变量约定（数值；时间类按其自然单位填写，函数内换算为 _ms）：
 *   REFLUX_T_SILENT_DAYS、REFLUX_ELIMINATION_WINDOW_DAYS、REFLUX_ELIMINATION_THRESHOLD、
 *   REFLUX_MIN_SAMPLE、REFLUX_PROMOTION_N_HARD、REFLUX_PROMOTION_N_SOFT、REFLUX_HIGH_SCORE、
 *   REFLUX_STARTER_M、REFLUX_STARTER_TOPN、REFLUX_PIPELINE_LLM_BUDGET、REFLUX_DISTILL_BATCH、
 *   REFLUX_DISTILL_MAX_INTERVAL_MIN、REFLUX_DEDUP_K、REFLUX_TRAJ_N、REFLUX_TRAJ_T_HOURS、
 *   REFLUX_T4T5_TIMEOUT_SEC、REFLUX_CONNECTOR_DOWNGRADE_STREAK
 *
 * @param overrides 来自 JSON 的部分覆盖（可选）。
 */
export function resolveRefluxConfig(overrides: Partial<RefluxConfig> = {}): RefluxConfig {
  const d = DEFAULT_REFLUX_CONFIG;

  // 时间类环境变量按自然单位读入后换算为毫秒。
  const tSilentDays = envNum("REFLUX_T_SILENT_DAYS");
  const elimWindowDays = envNum("REFLUX_ELIMINATION_WINDOW_DAYS");
  const distillMaxMin = envNum("REFLUX_DISTILL_MAX_INTERVAL_MIN");
  const trajTHours = envNum("REFLUX_TRAJ_T_HOURS");
  const t4t5Sec = envNum("REFLUX_T4T5_TIMEOUT_SEC");

  return {
    // 反馈 / 静默
    T_silent_ms: pick(
      d.T_silent_ms,
      overrides.T_silent_ms,
      tSilentDays !== undefined ? tSilentDays * DAY_MS : undefined,
    ),
    // 淘汰
    Elimination_Window_ms: pick(
      d.Elimination_Window_ms,
      overrides.Elimination_Window_ms,
      elimWindowDays !== undefined ? elimWindowDays * DAY_MS : undefined,
    ),
    Elimination_Threshold: pick(
      d.Elimination_Threshold,
      overrides.Elimination_Threshold,
      envNum("REFLUX_ELIMINATION_THRESHOLD"),
    ),
    Min_Sample: pick(d.Min_Sample, overrides.Min_Sample, envNum("REFLUX_MIN_SAMPLE")),
    // 晋升
    Promotion_Threshold_N_hard: pick(
      d.Promotion_Threshold_N_hard,
      overrides.Promotion_Threshold_N_hard,
      envNum("REFLUX_PROMOTION_N_HARD"),
    ),
    Promotion_Threshold_N_soft: pick(
      d.Promotion_Threshold_N_soft,
      overrides.Promotion_Threshold_N_soft,
      envNum("REFLUX_PROMOTION_N_SOFT"),
    ),
    High_Score: pick(d.High_Score, overrides.High_Score, envNum("REFLUX_HIGH_SCORE")),
    // 冷启动
    Starter_M: pick(d.Starter_M, overrides.Starter_M, envNum("REFLUX_STARTER_M")),
    Starter_TopN: pick(d.Starter_TopN, overrides.Starter_TopN, envNum("REFLUX_STARTER_TOPN")),
    // 成本 / 蒸馏
    Pipeline_LLM_Budget: pick(
      d.Pipeline_LLM_Budget,
      overrides.Pipeline_LLM_Budget,
      envNum("REFLUX_PIPELINE_LLM_BUDGET"),
    ),
    B: pick(d.B, overrides.B, envNum("REFLUX_DISTILL_BATCH")),
    DISTILL_MAX_INTERVAL_ms: pick(
      d.DISTILL_MAX_INTERVAL_ms,
      overrides.DISTILL_MAX_INTERVAL_ms,
      distillMaxMin !== undefined ? distillMaxMin * MINUTE_MS : undefined,
    ),
    // 去重
    Dedup_K: pick(d.Dedup_K, overrides.Dedup_K, envNum("REFLUX_DEDUP_K")),
    // 轨迹
    Traj_N: pick(d.Traj_N, overrides.Traj_N, envNum("REFLUX_TRAJ_N")),
    Traj_T_ms: pick(
      d.Traj_T_ms,
      overrides.Traj_T_ms,
      trajTHours !== undefined ? trajTHours * HOUR_MS : undefined,
    ),
    // 分发
    T4T5_Timeout_ms: pick(
      d.T4T5_Timeout_ms,
      overrides.T4T5_Timeout_ms,
      t4t5Sec !== undefined ? t4t5Sec * SECOND_MS : undefined,
    ),
    // 验证
    Connector_Downgrade_Streak: pick(
      d.Connector_Downgrade_Streak,
      overrides.Connector_Downgrade_Streak,
      envNum("REFLUX_CONNECTOR_DOWNGRADE_STREAK"),
    ),
  };
}
