/**
 * 河床系统（Riverbed System）· 域聚合态势（Domain Aggregation）
 * ------------------------------------------------------------------
 * 把多条判断包聚合成"当前对用户的总体态势"——取最高严重度、最高约束级别、
 * 最坏新鲜度、被阻断领域、是否需恢复，并汇总归一化所有证据 / 约束引用。
 * 这是 `buildConsciousness` 注入河床块前的总览来源。
 *
 * 重写自 3.1 蓝本（lib/wenlu/riverbed/domain-aggregation.ts），剥离 / 适配：
 *   - `JsonObject metadata` 外部类型依赖 → 整段去除。
 *   - `ContextFreshnessState` 外部类型 → 改用本地 `DomainFreshness`。
 *   - `l7ConstraintLevel` → 重命名为 `constraintLevel`（弟弟语义）。
 *   - `freshness` → 重命名为 `worstFreshness`（语义更显式）。
 *   - summary 改中文；空集合给固定占位串。
 *   - `@/lib/...` 路径别名 → 弟弟内部相对路径（带 `.js` 扩展）。
 *
 * 沿用 3.1 蓝本的 SEVERITY_RANK / FRESHNESS_RANK / L7_LEVEL_RANK 取最高 / 最坏模式。
 *
 * 绝对边界（requirements.md Requirement 14）：
 *   - 不 import 任何 3.1 / 3.2 路径的代码。
 *   - 不 import `node:sqlite`、不写 `import "server-only"`、不用 `@/lib/` 别名。
 *   - 纯 TypeScript ESM，相对导入一律带 `.js` 扩展。确定性纯函数，无副作用。
 *
 * _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_
 */

import type { RiverbedDomainId } from "./riverbed-domain.js";
import type {
  RiverbedConstraintRef,
  RiverbedEvidenceRef,
} from "./riverbed-evidence.js";
import {
  normalizeConstraintRefs,
  normalizeEvidenceRefs,
} from "./riverbed-evidence.js";
import type {
  DomainConstraintLevel,
  DomainFreshness,
  DomainJudgementPacket,
  DomainJudgementSeverity,
} from "./domain-judgement-packet.js";
import { assertNoEngineTrigger } from "./no-engine-trigger-guard.js";

/** 严重度排名（none < low < medium < high < critical）。 */
const SEVERITY_RANK: Record<DomainJudgementSeverity, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

/** 新鲜度排名（fresh < aging < manual_only < placeholder < stale，数值越大越坏）。 */
const FRESHNESS_RANK: Record<DomainFreshness, number> = {
  fresh: 0,
  aging: 1,
  manual_only: 2,
  placeholder: 3,
  stale: 4,
};

/** 约束级别排名（ADVISORY < WEAK_DEFAULT < STRONG_DEFAULT < HARD_CONSTRAINT < CONFIRMATION_GATE）。 */
const CONSTRAINT_LEVEL_RANK: Record<DomainConstraintLevel, number> = {
  ADVISORY: 0,
  WEAK_DEFAULT: 1,
  STRONG_DEFAULT: 2,
  HARD_CONSTRAINT: 3,
  CONFIRMATION_GATE: 4,
};

/** 空集合时的固定中文占位摘要。 */
const EMPTY_SUMMARY = "（暂无领域判断包）";

/**
 * 多条判断包聚合后的全局态势。
 * 取最高严重度 / 最高约束级别 / 最坏新鲜度 / 被阻断领域 / 是否需恢复，
 * 并汇总归一化全部证据与约束引用。
 */
export interface DomainJudgementAggregation {
  /** 中文摘要（空集合给固定占位串）。 */
  summary: string;
  /** 参与聚合的判断包数量。 */
  packetCount: number;
  /** 去重后的领域列表（按首次出现顺序）。 */
  domains: RiverbedDomainId[];
  /** 最高严重度；空集合返回 null。 */
  highestSeverity: DomainJudgementSeverity | null;
  /** 被阻断领域（verdict=block 或 constraintLevel=HARD_CONSTRAINT，去重）。 */
  blockedDomains: RiverbedDomainId[];
  /** 最高约束级别；空集合默认 ADVISORY。 */
  constraintLevel: DomainConstraintLevel;
  /** 最坏新鲜度；空集合返回 null。 */
  worstFreshness: DomainFreshness | null;
  /** 任一判断包需恢复即为 true。 */
  recoveryRequired: boolean;
  /** 汇总归一化去重后的证据引用。 */
  evidenceRefs: RiverbedEvidenceRef[];
  /** 汇总归一化去重后的约束引用。 */
  constraintRefs: RiverbedConstraintRef[];
}

/** 取严重度较高者（current 为 null 时直接取 next）。 */
function pickHighestSeverity(
  current: DomainJudgementSeverity | null,
  next: DomainJudgementSeverity,
): DomainJudgementSeverity {
  if (!current) return next;
  return SEVERITY_RANK[next] > SEVERITY_RANK[current] ? next : current;
}

/** 取新鲜度较坏者（current 为 null 时直接取 next）。 */
function pickWorstFreshness(
  current: DomainFreshness | null,
  next: DomainFreshness,
): DomainFreshness {
  if (!current) return next;
  return FRESHNESS_RANK[next] > FRESHNESS_RANK[current] ? next : current;
}

/** 取约束级别较高者。 */
function pickHighestConstraintLevel(
  current: DomainConstraintLevel,
  next: DomainConstraintLevel,
): DomainConstraintLevel {
  return CONSTRAINT_LEVEL_RANK[next] > CONSTRAINT_LEVEL_RANK[current] ? next : current;
}

/**
 * 把多条判断包聚合成全局态势。
 *
 * 算法：
 *   1. 每条 packet 入聚合前调用 `assertNoEngineTrigger`（沿用守卫蓝本）。
 *   2. domains：去重的领域列表（首次出现顺序）。
 *   3. blockedDomains：verdict=block 或 constraintLevel=HARD_CONSTRAINT 的 domain，去重。
 *   4. highestSeverity：取最高 rank；空集合 null。
 *   5. constraintLevel：取最高级别；空集合默认 ADVISORY。
 *   6. worstFreshness：取最坏 rank；空集合 null。
 *   7. recoveryRequired：任一 packet 需恢复即 true。
 *   8. evidenceRefs / constraintRefs：汇总后归一化去重。
 *   9. summary：中文摘要；空集合给固定占位串。
 *
 * 确定性纯函数：不修改输入。
 *
 * @param packets 判断包列表（只读）
 * @returns 聚合态势
 * @throws DOMAIN_ENGINE_TRIGGER_BLOCKED 任一 packet 夹带引擎触发字段
 */
export function aggregateDomainJudgementPackets(
  packets: readonly DomainJudgementPacket[],
): DomainJudgementAggregation {
  for (const packet of packets) {
    assertNoEngineTrigger(packet);
  }

  const domains = [...new Set(packets.map((packet) => packet.domain))];
  const blockedDomains = [
    ...new Set(
      packets
        .filter(
          (packet) =>
            packet.verdict === "block" || packet.constraintLevel === "HARD_CONSTRAINT",
        )
        .map((packet) => packet.domain),
    ),
  ];

  let highestSeverity: DomainJudgementSeverity | null = null;
  let worstFreshness: DomainFreshness | null = null;
  let constraintLevel: DomainConstraintLevel = "ADVISORY";
  const evidenceRefs: RiverbedEvidenceRef[] = [];
  const constraintRefs: RiverbedConstraintRef[] = [];

  for (const packet of packets) {
    highestSeverity = pickHighestSeverity(highestSeverity, packet.severity);
    worstFreshness = pickWorstFreshness(worstFreshness, packet.freshness);
    constraintLevel = pickHighestConstraintLevel(constraintLevel, packet.constraintLevel);
    evidenceRefs.push(...packet.evidenceRefs);
    constraintRefs.push(...packet.constraintRefs);
  }

  return {
    summary:
      packets.length === 0
        ? EMPTY_SUMMARY
        : `${packets.length} 条领域判断包，覆盖 ${domains.length} 个领域${
            blockedDomains.length > 0 ? `，${blockedDomains.length} 个领域被阻断` : ""
          }。`,
    packetCount: packets.length,
    domains,
    highestSeverity,
    blockedDomains,
    constraintLevel,
    worstFreshness,
    recoveryRequired: packets.some((packet) => packet.recoveryRequired),
    evidenceRefs: normalizeEvidenceRefs(evidenceRefs),
    constraintRefs: normalizeConstraintRefs(constraintRefs),
  };
}
