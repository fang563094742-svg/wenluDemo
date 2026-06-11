/**
 * 时空校准层 · 时间衰减与三信号融合（V2：chronotopic-decay.ts）
 * ------------------------------------------------------------------
 * V2 的核心：对标 TSM（Time-aware Sequential Memory）的「时间衰减 + 语义」双信号，
 * 再叠加 Tiered Memory 的「层级/认知」第三信号，把河床节点 / 记忆条目做一层
 * **确定性重排**。本模块不修改既有 retrieveRelevant / getActiveRiverbedNodes 的
 * 源码与签名——调用方在拿到它们的结果后，额外调用 rankByTriSignal 叠加重排。
 *
 * 三信号（参见 design.md §10 V2 与 requirements.md R6/R7）：
 *  1. 时间衰减 temporalDecay：指数衰减 2^(-age/halfLife)，越旧越低、单调非增、∈ (0,1]。
 *  2. 语义相关 semantic：复用 retrieveRelevant 的 BM25 归一分（[0,1]，本模块不重造）。
 *  3. 认知权重 cognitive：severity×authority 或 importance（含 tierBoost），作为重要度。
 *
 * 关键性质（属性测试会验证，实现必须保证）：
 *  - 衰减值域：temporalDecay ∈ (0,1]；age=0→1；age=halfLife→0.5；对 age 单调非增。
 *  - 融合单调：权重非负时，fuseTriSignal 对任一信号分量单调非减。
 *  - 重排是排列且稳定：rankByTriSignal 输出与输入同长、同元素多重集合（不丢不增不改），
 *    按 fused 降序；fused 相等时保持输入相对顺序；每元素只调一次 project。
 *
 * 绝对边界（贯穿全时空层，参见 requirements.md Requirement 14）：
 *  - 不 import 任何 3.1 / 3.2 路径的代码、不调其 API、不碰其 sqlite。
 *  - 不 import "server-only"、不 import "node:sqlite"、不用 @/lib 路径别名。
 *  - 确定性纯函数：不读真实时钟、不读随机源，全部由入参推出。
 *  - 纯 TypeScript ESM，相对导入一律带 `.js` 扩展（Node ≥ 22）。
 *
 * _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 7.1, 7.2, 7.3, 7.4, 7.5, 7.6_
 */

import { clamp01 } from "./chronotopic-calibrator.js";
import { ageMs } from "./chronotopic-time.js";
import type { ChronotopicState } from "./chronotopic-store.js";

/** 时间衰减权重配置（半衰期，单位与 ageMs 一致：毫秒）。前置条件：halfLifeMs > 0。 */
export interface DecayConfig {
  /** 半衰期（毫秒）：age 达到该值时衰减分恰为 0.5。应 > 0。 */
  halfLifeMs: number;
}

/** 三信号融合权重（各分量为非负权重；调用方可不归一，融合分只用于相对排序）。 */
export interface TriSignalWeights {
  /** 时间衰减权重。 */
  temporal: number;
  /** 语义相关权重。 */
  semantic: number;
  /** 认知权重（含层级提升 tierBoost）。 */
  cognitive: number;
}

/**
 * 默认三信号权重（确定性常量）。
 *
 * 对标 TSM：以「时间衰减 + 语义」双信号为主（各 0.4），认知/层级信号为辅（0.2）——
 * 时间新鲜度与语义相关同等重要，重要度/层级作为打破平局的辅助权重。三权重均非负，
 * 满足 fuseTriSignal 的单调性前提。
 */
export const DEFAULT_TRI_SIGNAL_WEIGHTS: TriSignalWeights = {
  temporal: 0.4,
  semantic: 0.4,
  cognitive: 0.2,
};

/** 单条目的三信号输入（由调用方从既有结构投影出来）。 */
export interface TriSignalInput {
  /** 时间衰减分 ∈ (0,1]（由 temporalDecay 算出）。 */
  decay: number;
  /** 语义相关分 ∈ [0,1]（复用 BM25 归一分）。 */
  semantic: number;
  /** 认知权重分 ∈ [0,1]（severity×authority 或 importance，含 tierBoost）。 */
  cognitive: number;
}

/**
 * 指数时间衰减：`2^(-age / halfLife)`（确定性纯函数，不读时钟、不读随机）。
 *
 * 形式化规格（参见 design.md §10）：
 *  - Preconditions：config.halfLifeMs > 0；ageMsValue ≥ 0（负值由调用方经 ageMs 钳为 0）。
 *  - Postconditions：返回值 ∈ (0,1]；age=0 → 1；age=halfLife → 0.5；对 age 单调非增。
 *
 * 边界防护（不抛错、不返回 NaN）：
 *  - halfLifeMs ≤ 0（违反前置条件）时，无法定义衰减量纲，返回安全值 1（视作「不衰减」）。
 *  - ageMsValue ≤ 0（含 NaN 之外的非正数）时，返回 1（age=0 的恒等）。
 *
 * @param ageMsValue 距今时长（毫秒），应 ≥ 0
 * @param config 衰减配置（半衰期，毫秒）
 * @returns 落在 (0,1] 的衰减分
 */
export function temporalDecay(ageMsValue: number, config: DecayConfig): number {
  // 违反前置条件的半衰期：不崩溃，按「不衰减」返回 1。
  if (!(config.halfLifeMs > 0)) return 1;
  // age ≤ 0（含未来事件已被 ageMs 钳为 0 的情形）：恒等于 1。
  if (!(ageMsValue > 0)) return 1;
  // 极旧记忆（age/halfLife 极大）时，Math.pow(2, -x) 在 IEEE754 双精度下会下溢为精确的 0，
  // 违反值域严格下界 (0,1]（0 不属于该区间）。为保留「无限旧」记忆的留痕语义（趋近 0 但不为 0，
  // 不在加权融合里彻底消失），下溢时钳到最小正规非零值 Number.MIN_VALUE。
  // 单调非增不被破坏：更旧的 age 同样会被钳到 MIN_VALUE，相等仍满足 non-increasing。
  const d = Math.pow(2, -ageMsValue / config.halfLifeMs);
  return d > 0 ? d : Number.MIN_VALUE;
}

/**
 * 三信号融合分：`fused = w.temporal×decay + w.semantic×semantic + w.cognitive×cognitive`。
 *
 * 形式化规格（参见 design.md §10）：
 *  - Postconditions：返回值 = 三个 clamp01 后信号的加权和；权重非负时对任一信号单调非减。
 *
 * 各信号分量先经 clamp01 钳到 [0,1]（吸收越界 / NaN），再按权重线性组合。纯函数；
 * 结果只用于相对排序（不要求绝对可比）。
 *
 * @param input 三信号输入（decay / semantic / cognitive）
 * @param weights 融合权重，默认 DEFAULT_TRI_SIGNAL_WEIGHTS
 * @returns 加权融合分
 */
export function fuseTriSignal(
  input: TriSignalInput,
  weights: TriSignalWeights = DEFAULT_TRI_SIGNAL_WEIGHTS,
): number {
  return (
    weights.temporal * clamp01(input.decay) +
    weights.semantic * clamp01(input.semantic) +
    weights.cognitive * clamp01(input.cognitive)
  );
}

/**
 * 对一组候选做确定性三信号重排（稳定排序：fused 相等时保持输入顺序）。
 *
 * 形式化规格（参见 design.md §10）：
 *  - Postconditions：输出是输入的一个**排列**（同长、同元素集合，不丢不增不改）；
 *    按 fused 降序；fused 相等时保持输入相对顺序（稳定）。
 *  - 实现保证：排序前对每个元素只调用一次 project 缓存 fused 分；排序过程只比较缓存值
 *    与原始 index（不重复调用 project），从而即便 project 读时钟也只被调用一次/元素。
 *
 * @param items 候选数组（不被修改）
 * @param project 把单个候选投影为 TriSignalInput（每元素只调用一次）
 * @param weights 融合权重，默认 DEFAULT_TRI_SIGNAL_WEIGHTS
 * @returns 按 fused 降序、稳定排序后的 item 数组（输入的一个排列）
 */
export function rankByTriSignal<T>(
  items: T[],
  project: (item: T) => TriSignalInput,
  weights: TriSignalWeights = DEFAULT_TRI_SIGNAL_WEIGHTS,
): T[] {
  // 一次性算好每个元素的 fused 分并记下原始 index（用于稳定排序的平局判定）。
  const scored = items.map((item, index) => ({
    item,
    fused: fuseTriSignal(project(item), weights),
    index,
  }));

  // fused 降序；相等时按原 index 升序 → 保持输入相对顺序（稳定）。
  scored.sort((a, b) => (b.fused - a.fused) || (a.index - b.index));

  return scored.map((s) => s.item);
}

/**
 * 新鲜权重裁剪阈值（确定性常量）：`temporalDecay` 算出的新鲜权重 < 该值的签名视作
 * 「回光已熄」——不再注入意识、并在裁剪时被优先移除。
 *
 * 取 `2^-4 = 0.0625`，即年龄超过 4 个半衰期（age > 4×halfLife）的签名被裁掉：
 * 以接线点 30 天半衰期计，约 120 天未更新的签名退出容器。阈值为闭区间下界——
 * 权重恰等于 FRESHNESS_FLOOR 的签名被保留（只有严格小于才裁），保证边界确定。
 */
export const FRESHNESS_FLOOR = 0.0625;

/**
 * 回光降权：用时间衰减给每条签名算新鲜权重，裁掉低于 FRESHNESS_FLOOR 的过旧签名。
 *
 * 形式化规格（参见 design.md §11.3 与 requirements.md Requirement 11）：
 *  - Postconditions：调用后 `state.signatures` 长度 ≤ 调用前（只减不增，R11.1）；
 *    保留集合 ⊆ 原集合（不新增、不改写签名，R11.2）；新鲜权重 < FRESHNESS_FLOOR
 *    的签名被裁剪、不再被注入意识（R11.5）。
 *  - 确定性：相同 `(state, nowMs, config)` 输入恒得相同结果（R11.3）——纯结构操作，
 *    不读真实时钟、不读随机源。
 *
 * 新鲜权重 = `temporalDecay(ageMs(Date.parse(createdAt), nowMs), config)`。
 * `createdAt` 解析失败（NaN，损坏字段）时按「无穷旧」处理：age = +Infinity →
 * 新鲜权重经 temporalDecay 趋近 0（下溢钳为 Number.MIN_VALUE）< FRESHNESS_FLOOR，
 * 故损坏签名被确定性裁剪，不抛错、不污染结果。
 *
 * 原地修改 `state.signatures`（与 `pruneSignatures` 同构）；对损坏 / 缺字段的 state
 * 容错（signatures 缺失视作空数组，返回 0）。
 *
 * @param state 时空容器（原地裁剪）
 * @param nowMs 当前参考时刻（毫秒，新鲜度基准）
 * @param config 衰减配置（半衰期，毫秒）
 * @returns 被裁剪的签名数量（调用前长度 − 调用后长度）
 */
export function decayChronotopic(
  state: ChronotopicState,
  nowMs: number,
  config: DecayConfig,
): number {
  const signatures = state?.signatures ?? [];
  const before = signatures.length;
  if (before === 0) return 0;

  const kept = signatures.filter((signature) => {
    const createdMs = Date.parse(signature.createdAt);
    // createdAt 解析失败：按「无穷旧」处理 → 新鲜权重趋近 0 → 被裁剪。
    const age = Number.isNaN(createdMs) ? Number.POSITIVE_INFINITY : ageMs(createdMs, nowMs);
    const freshness = temporalDecay(age, config);
    // 严格小于阈值才裁剪；恰等于 FRESHNESS_FLOOR 保留（边界确定）。
    return freshness >= FRESHNESS_FLOOR;
  });

  state.signatures = kept;
  return before - kept.length;
}
