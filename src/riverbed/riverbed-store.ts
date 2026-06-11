/**
 * 河床系统（Riverbed System）· 节点持久化层（Riverbed Store）
 * ------------------------------------------------------------------
 * 这是河床节点在 `mind.riverbed` 上的读写层，也是河床与弟弟身份融合的关键接线点。
 * **不引入 sqlite**——节点就是 mind.json 里的一个数组（`RiverbedState.nodes`）。
 * 写盘复用 riverMain.ts 既有的 `saveMind`（本文件不开辟新写盘通道）。
 *
 * 本文件职责（design.md Component 6 + 算法二）：
 *   - 定义 `RiverbedNode` / `RiverbedState` 数据结构。
 *   - `emptyRiverbedState`：初值容器（loadMind 默认值，零破坏旧 mind.json）。
 *   - `getRiverbedNodes`：读节点，对 `nodes ?? []` 容错（Requirement 13.3）。
 *   - `getActiveRiverbedNodes`：活跃节点读路径（过滤 + 排序 + 截断，无副作用）。
 *   - `upsertRiverbedNode`：算法二，幂等去重 + 升级（同 packetId 不重复建节点）。
 *   - `pruneRiverbedNodes`：防膨胀淘汰，保护 critical / recoveryRequired 节点。
 *
 * 纯度说明：除 `updatedAt` 使用 `new Date().toISOString()`（store 本就非纯函数，
 * 允许读时钟）外，其余排序 / 价值分 / 权威分均为确定性计算（无随机）。
 * `getActiveRiverbedNodes` 不修改输入（Requirement 4.4）。
 *
 * 绝对边界（requirements.md Requirement 14）：
 *   - 不 import 任何 3.1 / 3.2 路径的代码。
 *   - 不 import `node:sqlite`、不写 `import "server-only"`、不用 `@/lib/` 别名。
 *   - 纯 TypeScript ESM，相对导入一律带 `.js` 扩展。
 *
 * _Requirements: 4.3, 4.4, 4.5, 5.1, 5.2, 5.3, 5.4, 12.1, 12.2, 12.3, 13.3_
 */

import { clamp01 } from "./riverbed-util.js";
import type {
  DomainFreshness,
  DomainJudgementPacket,
  DomainJudgementSeverity,
} from "./domain-judgement-packet.js";

/**
 * 河床节点 = 一条稳定的领域判断 + 打断权威分（可被回光校准）。
 * `nodeId` 恒等于 `packet.packetId`（稳定哈希），天然保证幂等与唯一。
 */
export interface RiverbedNode {
  /** 节点稳定标识，= packet.packetId（同语义判断恒等，天然幂等去重）。 */
  nodeId: string;
  /** 所承载的领域判断包。 */
  packet: DomainJudgementPacket;
  /** 打断权威分 ∈ [0,1]（沿用 past-riverbed 概念，由 reflux 回光校准）。 */
  interruptAuthority: number;
  /** 被引用 / 印证次数（每次 upsert 同 packetId +1）。 */
  hitCount: number;
  /** 最近一次被引用的轮次。 */
  lastReferencedCycle: number;
  /** 创建时所在轮次。 */
  createdCycle: number;
  /** 最近一次更新时间（ISO 串）。 */
  updatedAt: string;
}

/**
 * 挂在 `Mind` 上的河床容器。
 * loadMind 以 `emptyRiverbedState()` 作默认值，零破坏既有 mind.json。
 */
export interface RiverbedState {
  /** 河床节点数组（nodeId 唯一）。 */
  nodes: RiverbedNode[];
  /** 上次兜底汇聚（sense）所在轮次。 */
  lastSenseCycle: number;
  /** 结构版本号（当前恒为 1）。 */
  version: 1;
}

/**
 * 严重度排名（none < low < medium < high < critical，数值越大越严重）。
 * 用于 active 排序与 prune 价值分的数值化（design.md：severity 需用 rank 参与排序）。
 */
const SEVERITY_RANK: Record<DomainJudgementSeverity, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

/** 严重度档位数（rank 上界 + 1），用于把 rank 归一到 [0,1]。 */
const SEVERITY_LEVELS = 5;

/**
 * 新鲜度价值分（越新鲜价值越高，stale 最低）。
 * 用于 prune 的"新鲜度"权重；与 aggregation 的 FRESHNESS_RANK 方向相反（这里越大越好）。
 */
const FRESHNESS_VALUE: Record<DomainFreshness, number> = {
  fresh: 1,
  aging: 0.8,
  manual_only: 0.6,
  placeholder: 0.4,
  stale: 0.2,
};

/**
 * 由判断包确定性地推导初始打断权威分（`deriveAuthority`）。
 *
 * 由 severity（none..critical → 0..1）与 confidence 加权（severity 权重 0.6、
 * confidence 权重 0.4），结果经 clamp01 落入 [0,1]。无随机、无时间依赖——
 * 同 packet 恒得同 interruptAuthority（Requirement 5.2）。
 *
 * @param packet 判断包
 * @returns 初始打断权威分 ∈ [0,1]
 */
function deriveAuthority(packet: DomainJudgementPacket): number {
  const severityWeight = SEVERITY_RANK[packet.severity] / (SEVERITY_LEVELS - 1);
  return clamp01(0.6 * severityWeight + 0.4 * clamp01(packet.confidence));
}

/**
 * 节点高价值排序分（severity × interruptAuthority × confidence）。
 * severity 用 rank 数值化参与排序（design.md / Requirement 4.4）。
 * 确定性函数，供 `getActiveRiverbedNodes` 降序排列。
 */
function activeValueScore(node: RiverbedNode): number {
  return (
    SEVERITY_RANK[node.packet.severity] *
    clamp01(node.interruptAuthority) *
    clamp01(node.packet.confidence)
  );
}

/**
 * 节点防膨胀价值分（severity × interruptAuthority × 新鲜度）。
 * 用于 `pruneRiverbedNodes` 选取最低者淘汰（Requirement 12.1）。
 * severity rank 加 1（使 none 域不恒为 0、保留 interruptAuthority/新鲜度的区分度）。
 */
function pruneValueScore(node: RiverbedNode): number {
  return (
    (SEVERITY_RANK[node.packet.severity] + 1) *
    clamp01(node.interruptAuthority) *
    FRESHNESS_VALUE[node.packet.freshness]
  );
}

/**
 * 节点是否为淘汰保护对象：severity 为 critical 或 recoveryRequired 为 true。
 * 受保护节点永不被 `pruneRiverbedNodes` 自动淘汰（Requirement 12.2）。
 */
function isProtectedNode(node: RiverbedNode): boolean {
  return node.packet.severity === "critical" || node.packet.recoveryRequired === true;
}

/**
 * 返回一个空的合法 RiverbedState。
 * `nodes` 为空数组、`lastSenseCycle` 为 0、`version` 为 1（Requirement 4.3）。
 *
 * @returns 初值 RiverbedState
 */
export function emptyRiverbedState(): RiverbedState {
  return { nodes: [], lastSenseCycle: 0, version: 1 };
}

/**
 * 读取河床节点列表，对损坏 / 缺字段的 state 容错。
 *
 * 对 `rb?.nodes ?? []` 容错：rb 为 null/undefined 或 nodes 缺失时返回空数组，
 * 退化为空河床而不崩溃（Requirement 13.3 / 场景 3）。
 *
 * @param rb 河床容器（可能损坏 / 缺字段）
 * @returns 节点数组（容错为空数组）
 */
export function getRiverbedNodes(rb: RiverbedState): RiverbedNode[] {
  return rb?.nodes ?? [];
}

/**
 * 读取活跃河床节点（喂进意识的读路径，无副作用）。
 *
 * 算法：
 *   1. 取节点（getRiverbedNodes 容错）。
 *   2. 排除 freshness 为 "stale" 且 recoveryRequired 为 false 的节点
 *      （陈旧且无需恢复 → 不再喂进意识）。
 *   3. 按 `severity × interruptAuthority × confidence` 降序（severity 用 rank）。
 *   4. 截断为前 maxN 个。
 *
 * 不修改输入的 RiverbedState（先 slice 拷贝再排序，Requirement 4.4）。
 *
 * @param rb 河床容器
 * @param now 当前时间（保留入参，便于未来基于时间的新鲜度判定）
 * @param maxN 返回上限，默认 15
 * @returns ≤ maxN 个活跃节点，按高价值降序
 */
export function getActiveRiverbedNodes(
  rb: RiverbedState,
  now: Date,
  maxN = 15,
): RiverbedNode[] {
  void now; // 当前以节点既存 freshness 过滤；now 预留给未来基于时钟的新鲜度衰减。
  const nodes = getRiverbedNodes(rb);

  const active = nodes.filter(
    (node) =>
      !(node.packet.freshness === "stale" && node.packet.recoveryRequired === false),
  );

  // slice() 拷贝后排序，绝不修改入参 rb.nodes（无副作用）。
  return active
    .slice()
    .sort((a, b) => activeValueScore(b) - activeValueScore(a))
    .slice(0, Math.max(0, maxN));
}

/**
 * 节点 upsert：幂等去重 + 升级（design.md 算法二）。
 *
 * 既有同 packetId 节点：不新建，confidence 取既有与新值的较大者、hitCount + 1、
 * 更新 lastReferencedCycle 与 updatedAt，返回 `created: false`。
 * 不存在：新建节点，hitCount = 1、interruptAuthority = deriveAuthority(packet)、
 * createdCycle = lastReferencedCycle = cycle，返回 `created: true`。
 *
 * nodeId 恒等于 packet.packetId（稳定哈希），保证 `rb.nodes` 中 nodeId 唯一
 * （Requirement 5.1 / 5.2 / 5.3 / 5.4）。
 *
 * @param rb 河床容器（原地写入）
 * @param packet 已通过守卫的判断包
 * @param cycle 当前轮次
 * @returns 命中或新建的节点与 `created` 标志
 */
export function upsertRiverbedNode(
  rb: RiverbedState,
  packet: DomainJudgementPacket,
  cycle: number,
): { node: RiverbedNode; created: boolean } {
  const existing = rb.nodes.find((node) => node.nodeId === packet.packetId);

  if (existing) {
    existing.packet.confidence = Math.max(existing.packet.confidence, packet.confidence);
    existing.hitCount += 1;
    existing.lastReferencedCycle = cycle;
    existing.updatedAt = new Date().toISOString();
    return { node: existing, created: false };
  }

  const node: RiverbedNode = {
    nodeId: packet.packetId,
    packet,
    interruptAuthority: deriveAuthority(packet),
    hitCount: 1,
    lastReferencedCycle: cycle,
    createdCycle: cycle,
    updatedAt: new Date().toISOString(),
  };
  rb.nodes.push(node);
  return { node, created: true };
}

/**
 * 防膨胀淘汰：节点数超上限时按价值分淘汰最低者（design.md 场景 4）。
 *
 * 算法（Requirement 12.1 / 12.2 / 12.3）：
 *   1. 节点数 ≤ maxNodes 直接返回 0。
 *   2. 仅在"未受保护"节点中按 `severity × interruptAuthority × 新鲜度` 价值分
 *      升序选取最低者淘汰，逐个移除直至节点数回到上限内或再无可淘汰节点。
 *   3. severity 为 critical 或 recoveryRequired 为 true 的节点受保护，永不被淘汰
 *      （即使因此仍超上限，也停止淘汰）。
 *   4. 返回被淘汰的节点数量。
 *
 * @param rb 河床容器（原地裁剪）
 * @param maxNodes 节点上限，默认 200（与弟弟 episodic 200 对齐）
 * @returns 被淘汰的节点数量
 */
export function pruneRiverbedNodes(rb: RiverbedState, maxNodes = 200): number {
  if (rb.nodes.length <= maxNodes) return 0;

  // 在未受保护节点中按价值分升序排序，最低者优先淘汰。
  const evictable = rb.nodes
    .filter((node) => !isProtectedNode(node))
    .sort((a, b) => pruneValueScore(a) - pruneValueScore(b));

  const removeCount = Math.min(rb.nodes.length - maxNodes, evictable.length);
  if (removeCount <= 0) return 0;

  const toRemove = new Set(evictable.slice(0, removeCount).map((node) => node.nodeId));
  rb.nodes = rb.nodes.filter((node) => !toRemove.has(node.nodeId));

  return removeCount;
}

// ──────────────────────────────────────────────────────────────────
// Task 10.1（reflux 回光校准）：现实信号回流，按证据校准节点（只校准不删）。
// 接 reflect 反思层（design.md 算法三 + Component / Requirement 11）。
// ──────────────────────────────────────────────────────────────────

/**
 * 一条已结算（hit / miss）的预测信号形状（复用弟弟 mind.predictions 的子集）。
 *
 * 与设计中的 `MindPredictionLike` 同形：只取回光校准需要的两个字段——
 *   - `status`：命中（hit）或落空（miss）。
 *   - `relatedTo`：关联领域（对应某节点 `packet.domain`，缺省时不关联任何域）。
 *
 * 用 `string` 而非 `RiverbedDomainId` 承载 `relatedTo`，因预测来源于弟弟既有
 * metrics，其关联域未必落在河床 14 域内；以字符串相等比较即可确定性匹配。
 */
export interface MindPredictionLike {
  /** 预测结算状态：命中或落空。 */
  status: "hit" | "miss";
  /** 关联领域（与节点 packet.domain 字符串相等即视为关联）。 */
  relatedTo?: string;
}

/**
 * 回光校准信号（来自弟弟既有 metrics / predictions）。
 *
 *   - `hitRate`：判断命中率 ∈ [0,1]。低于 0.4 时下调高严重度节点的权威分。
 *   - `repetition`：近期重复度（保留入参，供未来扩展，本算法暂不直接消费）。
 *   - `settledPredictions`：已结算预测列表，落空者衰减对应域节点的 confidence。
 */
export interface RefluxSignals {
  /** 判断命中率 ∈ [0,1]。 */
  hitRate: number;
  /** 近期重复度（保留入参，便于未来扩展）。 */
  repetition: number;
  /** 已结算（hit / miss）的预测列表。 */
  settledPredictions: MindPredictionLike[];
}

/**
 * 命中率阈值：低于此值视为"判断被现实证明不可靠"，下调高严重度节点权威。
 */
const REFLUX_LOW_HITRATE = 0.4;

/** 高严重度阈值（rank ≥ high），命中率低时其 interruptAuthority 衰减。 */
const REFLUX_HIGH_SEVERITY_RANK = SEVERITY_RANK.high;

/** 空闲轮次阈值：超过此值则 freshness 降级一档。 */
const REFLUX_IDLE_CYCLES = 50;

/** 命中率低时高严重度节点 interruptAuthority 的单次衰减量。 */
const REFLUX_AUTHORITY_DECAY = 0.05;

/** 落空预测命中关联域时节点 confidence 的单次衰减量。 */
const REFLUX_CONFIDENCE_DECAY = 0.1;

/**
 * 新鲜度降级一档（fresh→aging→manual_only→placeholder→stale，已 stale 保持）。
 * 确定性映射，最差档 stale 为吸收态（再降级仍为 stale），保证不会越界。
 */
const FRESHNESS_DOWNGRADE: Record<DomainFreshness, DomainFreshness> = {
  fresh: "aging",
  aging: "manual_only",
  manual_only: "placeholder",
  placeholder: "stale",
  stale: "stale",
};

/**
 * 回光校准 reflux（design.md 算法三）：按现实信号原地校准每个节点（只校准、不删除）。
 *
 * 对 `rb.nodes` 中每个节点：
 *   1. 命中率低（< 0.4）且节点 severity ≥ high（high / critical）→
 *      `interruptAuthority = clamp01(interruptAuthority - 0.05)`（Requirement 11.2）。
 *   2. 对每条 `status === "miss"` 且 `relatedTo === node.packet.domain` 的预测 →
 *      `confidence = clamp01(confidence - 0.1)`（可叠加，Requirement 11.3）。
 *   3. 空闲轮次 `currentCycle - node.lastReferencedCycle > 50` →
 *      `freshness` 降级一档（不删、留痕，Requirement 11.4）。
 *
 * 全程 clamp01 保证 confidence / interruptAuthority ∈ [0,1]；绝不删节点，
 * 校准后 `rb.nodes.length` 不变（Requirement 11.1 / 11.5）。
 *
 * 关于 `currentCycle`：空闲判定需要"当前轮次"作基准。本实现以独立的第三参数
 * 显式传入（reflect 调用时传 `mind.cycles`），而非藏进 signals——这样信号体
 * （来自 metrics / predictions）与时钟基准（来自 mind）职责分明，且函数对相同
 * `(rb, signals, currentCycle)` 输入恒得相同结果（确定性，无内部读时钟）。
 *
 * @param rb 河床容器（原地校准）
 * @param signals 现实回光信号 `{hitRate, repetition, settledPredictions}`
 * @param currentCycle 当前轮次（空闲判定基准，通常为 `mind.cycles`）
 */
export function refluxRiverbed(
  rb: RiverbedState,
  signals: RefluxSignals,
  currentCycle: number,
): void {
  const lowHitRate = signals.hitRate < REFLUX_LOW_HITRATE;

  for (const node of rb.nodes) {
    // ① 命中率低 + 高严重度 → 下调打断权威分。
    if (lowHitRate && SEVERITY_RANK[node.packet.severity] >= REFLUX_HIGH_SEVERITY_RANK) {
      node.interruptAuthority = clamp01(node.interruptAuthority - REFLUX_AUTHORITY_DECAY);
    }

    // ② 关联域落空预测 → 下调 confidence（多条落空可叠加衰减）。
    for (const prediction of signals.settledPredictions) {
      if (prediction.status === "miss" && prediction.relatedTo === node.packet.domain) {
        node.packet.confidence = clamp01(node.packet.confidence - REFLUX_CONFIDENCE_DECAY);
      }
    }

    // ③ 长期未被引用 → 新鲜度降级一档（不删、留痕）。
    if (currentCycle - node.lastReferencedCycle > REFLUX_IDLE_CYCLES) {
      node.packet.freshness = FRESHNESS_DOWNGRADE[node.packet.freshness];
    }
  }
}
