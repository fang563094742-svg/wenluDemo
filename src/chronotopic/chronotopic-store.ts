/**
 * 时空校准层 · 持久化层（Component 4：chronotopic-store.ts）
 * ------------------------------------------------------------------
 * 时空签名在 `mind.chronotopic` 旁路容器上的读 / 写 / 幂等 upsert / 活跃读取 /
 * 防膨胀裁剪层。结构与河床 `riverbed-store.ts` 同构：**不引入 sqlite**——签名
 * 就是 mind.json 里的一个数组（`ChronotopicState.signatures`），写盘复用
 * riverMain.ts 既有的 `saveMind`（本文件不开辟新写盘通道）。
 *
 * 本文件职责（design.md Component 4 + requirements.md Requirement 4）：
 *   - 定义 `ChronotopicState` 数据结构（`{ signatures, version: 1 }`）。
 *   - `emptyChronotopicState`：空容器（loadMind 兜底，零破坏旧 mind.json）。
 *   - `getSignatures`：容错读取（state 损坏 / 缺字段时退化空数组）。
 *   - `upsertSignature`：幂等 upsert（同 signatureId 覆盖更新，返回 {created}）。
 *   - `getActiveSignatures`：活跃读路径（按新鲜度 + 场景排序、截断、无副作用）。
 *   - `pruneSignatures`：防膨胀裁剪（超上限按时间衰减价值升序淘汰最旧最弱者）。
 *
 * 纯度说明：本层为薄持久化层（store 本就非纯函数惯例）。但所有时间相关计算
 * （新鲜度排序、淘汰价值分）一律以入参 `nowMs` 为基准，不读真实时钟、不读随机，
 * 从而对相同 `(state, nowMs, maxN)` 输入恒得相同结果。`getActiveSignatures`
 * 不修改输入（先 slice 拷贝再排序，Requirement 4.4）。
 *
 * 签名仅存于 `mind.chronotopic` 旁路容器，**绝不写入 `DomainJudgementPacket`
 * 字段**（Requirement 4.1）——签名与 packet 解耦，不污染 packet 哈希。
 *
 * 绝对边界（requirements.md Requirement 14）：
 *   - 不 import 任何 3.1 / 3.2 路径的代码、不调其 API、不碰其 sqlite。
 *   - 不 import `node:sqlite`、不写 `import "server-only"`、不用 `@/lib/` 别名。
 *   - 纯 TypeScript ESM，相对导入一律带 `.js` 扩展（Node ≥ 22）。
 *
 * _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7_
 */

import { ageMs } from "./chronotopic-time.js";
import type { ChronotopicScene, ChronotopicSignature } from "./chronotopic-signature.js";

/**
 * 挂在 `Mind` 上的时空容器（与 `mind.riverbed` 平级的旁路 sidecar）。
 * loadMind 以 `emptyChronotopicState()` 作默认值，零破坏既有 mind.json。
 */
export interface ChronotopicState {
  /** 时空签名数组（signatureId 唯一，由 upsert 幂等保证）。 */
  signatures: ChronotopicSignature[];
  /** 结构版本号（当前恒为 1）。 */
  version: 1;
}

/** `getActiveSignatures` 默认返回上限。 */
const DEFAULT_ACTIVE_MAX = 10;
/** `pruneSignatures` 默认签名上限（与设计场景 4 对齐）。 */
const DEFAULT_PRUNE_MAX = 300;

/**
 * 计算一条签名相对 `nowMs` 的距今时长（毫秒），用于新鲜度排序与淘汰。
 *
 * `createdAt` 解析失败（NaN，损坏字段）时按「无穷旧」处理（返回 +Infinity）——
 * 在活跃排序中排到最后、在裁剪中最优先被淘汰，保证损坏数据不污染结果且不抛错。
 *
 * @param signature 时空签名
 * @param nowMs 当前参考时刻（毫秒）
 * @returns 非负的距今毫秒数；createdAt 损坏时为 +Infinity
 */
function signatureAge(signature: ChronotopicSignature, nowMs: number): number {
  const createdMs = Date.parse(signature.createdAt);
  if (Number.isNaN(createdMs)) return Number.POSITIVE_INFINITY;
  return ageMs(createdMs, nowMs);
}

/**
 * 场景优先级：非 idle 场景优先（rank 越小越靠前）。
 *
 * 用作活跃排序的次级键——新鲜度相同时，有实质场景（coding/meeting/…）的签名
 * 排在 idle（空闲）签名之前。
 *
 * @param scene 场景档
 * @returns 0（非 idle，优先）或 1（idle，靠后）
 */
function sceneRank(scene: ChronotopicScene): number {
  return scene === "idle" ? 1 : 0;
}

/**
 * 返回一个空的合法 ChronotopicState。
 * `signatures` 为空数组、`version` 为 1（Requirement 4.7）。
 *
 * @returns 初值 ChronotopicState
 */
export function emptyChronotopicState(): ChronotopicState {
  return { signatures: [], version: 1 };
}

/**
 * 读取时空签名列表，对损坏 / 缺字段的 state 容错。
 *
 * 对 `state?.signatures ?? []` 容错：state 为 null/undefined 或 signatures 缺失
 * 时返回空数组，退化为空容器而不崩溃（Requirement 13.x / 15.2）。
 *
 * @param state 时空容器（可能损坏 / 缺字段）
 * @returns 签名数组（容错为空数组）
 */
export function getSignatures(state: ChronotopicState): ChronotopicSignature[] {
  return state?.signatures ?? [];
}

/**
 * 幂等 upsert：同 signatureId 覆盖更新该条，否则追加。返回 `{created}`。
 *
 * 既有同 signatureId 签名：原地替换为新签名（覆盖更新），返回 `created: false`，
 * 使该 signatureId 在 `signatures` 中恰出现一次（Requirement 4.2 / 4.3）。
 * 不存在：追加新签名，返回 `created: true`。
 *
 * 直接对 `state.signatures` 原地写入（与河床 store 同构）。调用完成后
 * `state.signatures` 的长度等于其中不同 signatureId 的个数。
 *
 * @param state 时空容器（原地写入）
 * @param signature 待写入的时空签名
 * @returns `{ created }`：true 表示新建追加，false 表示覆盖更新既有
 */
export function upsertSignature(
  state: ChronotopicState,
  signature: ChronotopicSignature,
): { created: boolean } {
  const index = state.signatures.findIndex(
    (existing) => existing.signatureId === signature.signatureId,
  );

  if (index >= 0) {
    state.signatures[index] = signature;
    return { created: false };
  }

  state.signatures.push(signature);
  return { created: true };
}

/**
 * 读取活跃时空签名（喂进意识的读路径，无副作用）。
 *
 * 算法：
 *   1. 取签名（getSignatures 容错）。
 *   2. 按新鲜度升序排序：`ageMs(createdAt, nowMs)` 越小（越近）越靠前。
 *   3. 新鲜度相同时，按场景次级排序：非 idle 场景优先于 idle。
 *   4. 仍相同则保持输入相对顺序（携带原始下标作末级键，稳定排序）。
 *   5. 截断为前 maxN 个。
 *
 * 不修改输入的 ChronotopicState（先 slice 拷贝再排序，Requirement 4.4）——
 * 调用前后 `state.signatures` 深度不变。
 *
 * @param state 时空容器
 * @param nowMs 当前参考时刻（毫秒，新鲜度基准）
 * @param maxN 返回上限，默认 10
 * @returns ≤ maxN 个活跃签名，按新鲜度 + 场景降序
 */
export function getActiveSignatures(
  state: ChronotopicState,
  nowMs: number,
  maxN: number = DEFAULT_ACTIVE_MAX,
): ChronotopicSignature[] {
  const signatures = getSignatures(state);

  // 携带原始下标以保证排序稳定（先 slice 拷贝，绝不修改入参）。
  const decorated = signatures.map((signature, index) => ({
    signature,
    index,
    age: signatureAge(signature, nowMs),
  }));

  decorated.sort(
    (a, b) =>
      a.age - b.age ||
      sceneRank(a.signature.scene) - sceneRank(b.signature.scene) ||
      a.index - b.index,
  );

  return decorated.slice(0, Math.max(0, maxN)).map((entry) => entry.signature);
}

/**
 * 防膨胀裁剪：签名数超上限时按时间衰减价值升序淘汰最旧最弱者。返回淘汰数。
 *
 * 算法（Requirement 4.5 / 4.6）：
 *   1. 取签名（getSignatures 容错）；上限钳到非负（maxN < 0 视为 0）。
 *   2. 当前数 ≤ 上限直接返回 0（未超不裁剪）。
 *   3. 否则保留新鲜度最高（age 最小）的前 maxN 条——等价于按时间衰减价值
 *      升序淘汰最旧最弱者（age 越大、衰减价值越低，越优先淘汰）。
 *   4. 原地裁剪 `state.signatures`，返回「调用前长度 − 调用后长度」的淘汰数。
 *
 * 携带原始下标作稳定键，保证同 age 时裁剪结果确定。
 *
 * @param state 时空容器（原地裁剪）
 * @param nowMs 当前参考时刻（毫秒，淘汰价值基准）
 * @param maxN 签名上限，默认 300
 * @returns 被淘汰的签名数量（调用前长度 − 调用后长度）
 */
export function pruneSignatures(
  state: ChronotopicState,
  nowMs: number,
  maxN: number = DEFAULT_PRUNE_MAX,
): number {
  const signatures = getSignatures(state);
  const before = signatures.length;
  const limit = Math.max(0, maxN);

  if (before <= limit) return 0;

  // 携带原始下标，按新鲜度升序（age 小者保留）稳定排序，保留前 limit 条。
  const decorated = signatures.map((signature, index) => ({
    index,
    age: signatureAge(signature, nowMs),
  }));

  decorated.sort((a, b) => a.age - b.age || a.index - b.index);

  const keepIndices = new Set(decorated.slice(0, limit).map((entry) => entry.index));
  state.signatures = signatures.filter((_, index) => keepIndices.has(index));

  return before - state.signatures.length;
}
