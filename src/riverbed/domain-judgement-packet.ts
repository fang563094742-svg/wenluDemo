/**
 * 河床系统（Riverbed System）· 判断包构建（Domain Judgement Packet）
 * ------------------------------------------------------------------
 * 这是河床的核心数据单元。每一条河床判断都被构建成一个 `DomainJudgementPacket`：
 * 经守卫校验（判断不驱动执行）、字段归一化（clamp01 / 证据去重）、稳定哈希
 * （同语义输入 → 同 packetId，天然幂等去重）的结构化判断包。
 *
 * 重写自 3.1 蓝本（lib/wenlu/riverbed/domain-judgement-packet.ts），剥离：
 *   - `userId`（弟弟是单用户单身份，无多租户）。
 *   - `ContextFreshnessState` 外部类型依赖 → 内联为本文件 `DomainFreshness`。
 *   - `JsonObject metadata` 外部类型依赖 → 整段去除。
 *   - `@/lib/...` 路径别名 → 改弟弟内部相对路径（带 `.js` 扩展）。
 *   - `l7ConstraintLevel` → 重命名为 `constraintLevel`（弟弟语义）。
 *
 * 绝对边界（requirements.md Requirement 14）：
 *   - 除 `node:crypto` 外不 import 任何外部依赖。
 *   - 不 import 3.1 / 3.2 路径、不 import `node:sqlite`、不写 `import "server-only"`、
 *     不用 `@/lib/` 别名。
 *   - 纯 TypeScript ESM，相对导入一律带 `.js` 扩展。
 *
 * _Requirements: 1.5, 2.1, 2.2, 2.3, 2.4, 2.5, 3.2, 3.4, 3.6_
 */

import { createHash } from "node:crypto";

import { clamp01 } from "./riverbed-util.js";
import type { RiverbedDomainId } from "./riverbed-domain.js";
import { isRiverbedDomainId } from "./riverbed-domain.js";
import type {
  RiverbedConstraintRef,
  RiverbedEvidenceRef,
} from "./riverbed-evidence.js";
import {
  normalizeConstraintRefs,
  normalizeEvidenceRefs,
} from "./riverbed-evidence.js";
import { assertNoEngineTrigger } from "./no-engine-trigger-guard.js";

/** 判断指向的对象类型（弟弟内部实体语义）。 */
export type DomainTargetObjectType =
  | "belief"
  | "userModel"
  | "conversation"
  | "context"
  | "manual"
  | "riverbed";

/** 判断的语义类型。 */
export type DomainJudgementType =
  | "alignment"
  | "risk"
  | "conflict"
  | "opportunity"
  | "constraint"
  | "rewrite"
  | "recovery"
  | "boundary"
  | "signal";

/** 判断的严重度（none < low < medium < high < critical）。 */
export type DomainJudgementSeverity = "none" | "low" | "medium" | "high" | "critical";

/** 判断的否决级别（河床唯一的"态度"输出，不含执行）。 */
export type DomainJudgementVerdict =
  | "support"
  | "warn"
  | "block"
  | "rewrite"
  | "observe"
  | "escalate"
  | "confirm_required";

/**
 * 判断的新鲜度状态（内联自 3.1 的 `ContextFreshnessState`）。
 * 弟弟河床不依赖 3.1 的 context 模块，故就地定义。
 */
export type DomainFreshness = "fresh" | "aging" | "manual_only" | "placeholder" | "stale";

/** 约束级别（由弱到强；弟弟语义，替代 3.1 的 `DomainL7ConstraintLevel`）。 */
export type DomainConstraintLevel =
  | "ADVISORY"
  | "WEAK_DEFAULT"
  | "STRONG_DEFAULT"
  | "HARD_CONSTRAINT"
  | "CONFIRMATION_GATE";

/**
 * 河床的核心数据单元：一条领域判断包。
 * 所有 score/confidence ∈ [0,1]；packetId 对同语义输入恒等（幂等去重基础）；
 * 永不夹带 `enginePacket` / `selectedEngine` / `executionAllowed`（守卫保证）。
 */
export interface DomainJudgementPacket {
  /** sha256 稳定哈希（同语义输入 → 同 id，天然幂等去重）。 */
  packetId: string;
  /** 所属 14 域之一。 */
  domain: RiverbedDomainId;
  /** 判断指向的对象类型。 */
  targetObjectType: DomainTargetObjectType;
  /** 判断指向对象的稳定标识（trim 后非空）。 */
  targetObjectId: string;
  /** 判断对象的中文摘要。 */
  targetSummary: string;
  /** 判断的语义类型。 */
  judgementType: DomainJudgementType;
  /** 判断分数，归一到 [0,1]。 */
  score: number;
  /** 判断置信度，归一到 [0,1]。 */
  confidence: number;
  /** 严重度。 */
  severity: DomainJudgementSeverity;
  /** 否决级别。 */
  verdict: DomainJudgementVerdict;
  /** 判断理由（中文）。 */
  reason: string;
  /** 新鲜度状态。 */
  freshness: DomainFreshness;
  /** 匹配到的既有节点 id（去重）。 */
  matchedNodeIds: string[];
  /** 可追溯证据引用（归一化去重）。 */
  evidenceRefs: RiverbedEvidenceRef[];
  /** 约束引用（归一化去重）。 */
  constraintRefs: RiverbedConstraintRef[];
  /** 约束级别。 */
  constraintLevel: DomainConstraintLevel;
  /** 建议的下一步（河床唯一的"行动影响力"——建议，非执行）。无建议为 null。 */
  suggestedNextStep: string | null;
  /** 建议砍掉的方向列表（去重，无建议为空数组）。 */
  suggestedCutList: string[];
  /** 是否需要恢复。 */
  recoveryRequired: boolean;
  /** 创建时间（ISO 串）。 */
  createdAt: string;
}

/**
 * 构建判断包的入参。
 * 在 `DomainJudgementPacket` 基础上把以下字段改为可选（构建时归一化 / 哈希生成）：
 *   - `packetId`（缺省时由 `stablePacketId` 稳定哈希生成）
 *   - `matchedNodeIds` / `evidenceRefs` / `constraintRefs` / `suggestedCutList`
 *     （缺省时归一化为空数组）
 */
export type BuildPacketInput = Omit<
  DomainJudgementPacket,
  | "packetId"
  | "matchedNodeIds"
  | "evidenceRefs"
  | "constraintRefs"
  | "suggestedCutList"
> & {
  packetId?: string;
  matchedNodeIds?: string[];
  evidenceRefs?: RiverbedEvidenceRef[];
  constraintRefs?: RiverbedConstraintRef[];
  suggestedCutList?: string[];
};

/**
 * 基于判断的语义字段计算稳定哈希 packetId。
 *
 * 取语义相关字段（domain / targetObjectType / targetObjectId / judgementType /
 * verdict / severity / constraintLevel / score / confidence / reason / createdAt）
 * 做 sha256，取前 20 位十六进制，加 `domain_packet_` 前缀。
 *
 * 同语义输入 → 同 packetId（幂等去重基础）。
 */
function stablePacketId(
  input: Pick<
    BuildPacketInput,
    | "domain"
    | "targetObjectType"
    | "targetObjectId"
    | "judgementType"
    | "verdict"
    | "severity"
    | "constraintLevel"
    | "score"
    | "confidence"
    | "reason"
    | "createdAt"
  >,
): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        domain: input.domain,
        targetObjectType: input.targetObjectType,
        targetObjectId: input.targetObjectId.trim(),
        judgementType: input.judgementType,
        verdict: input.verdict,
        severity: input.severity,
        constraintLevel: input.constraintLevel,
        score: input.score,
        confidence: input.confidence,
        reason: input.reason.trim(),
        createdAt: input.createdAt,
      }),
    )
    .digest("hex")
    .slice(0, 20);
  return `domain_packet_${digest}`;
}

/**
 * 构建一条经守卫校验、字段归一化、稳定哈希的领域判断包。
 *
 * 算法（design.md 算法一）：
 *   1. 入口 `assertNoEngineTrigger(input)`（守卫 1）——夹带引擎触发字段即抛
 *      `DOMAIN_ENGINE_TRIGGER_BLOCKED`。
 *   2. 校验 domain（先于其余所有校验）：非法立即抛
 *      `DOMAIN_JUDGEMENT_PACKET_INVALID_DOMAIN`。
 *   3. 校验 trim 后 targetObjectId 非空：为空抛
 *      `DOMAIN_JUDGEMENT_PACKET_TARGET_REQUIRED`。
 *   4. clamp01 归一化 score / confidence。
 *   5. 归一化 evidenceRefs / constraintRefs / suggestedCutList（trim + 去空 + 去重）。
 *   6. packetId = 已有值（trim 后非空）或稳定哈希。
 *   7. 无建议时 suggestedNextStep: null、suggestedCutList: []。
 *   8. 出口 `assertNoEngineTrigger(packet)`（守卫 2）。
 *
 * @param input 构建入参
 * @returns 归一化后的判断包（score/confidence ∈ [0,1]，永不夹带执行指令）
 * @throws DOMAIN_ENGINE_TRIGGER_BLOCKED 入参或产出夹带引擎触发字段
 * @throws DOMAIN_JUDGEMENT_PACKET_INVALID_DOMAIN domain 非 14 域之一
 * @throws DOMAIN_JUDGEMENT_PACKET_TARGET_REQUIRED targetObjectId trim 后为空
 */
export function buildDomainJudgementPacket(input: BuildPacketInput): DomainJudgementPacket {
  // 守卫 1：入口——杜绝夹带引擎触发字段。
  assertNoEngineTrigger(input);

  // domain 校验优先于其余所有校验，非法立即停止。
  if (!isRiverbedDomainId(input.domain)) {
    throw new Error("DOMAIN_JUDGEMENT_PACKET_INVALID_DOMAIN");
  }

  const targetObjectId = input.targetObjectId.trim();
  if (!targetObjectId) {
    throw new Error("DOMAIN_JUDGEMENT_PACKET_TARGET_REQUIRED");
  }

  const packet: DomainJudgementPacket = {
    packetId: input.packetId?.trim() || stablePacketId(input),
    domain: input.domain,
    targetObjectType: input.targetObjectType,
    targetObjectId,
    targetSummary: input.targetSummary.trim(),
    judgementType: input.judgementType,
    score: clamp01(input.score),
    confidence: clamp01(input.confidence),
    severity: input.severity,
    verdict: input.verdict,
    reason: input.reason.trim(),
    freshness: input.freshness,
    matchedNodeIds: [
      ...new Set((input.matchedNodeIds ?? []).map((item) => item.trim()).filter(Boolean)),
    ],
    evidenceRefs: normalizeEvidenceRefs(input.evidenceRefs ?? []),
    constraintRefs: normalizeConstraintRefs(input.constraintRefs ?? []),
    constraintLevel: input.constraintLevel,
    suggestedNextStep: input.suggestedNextStep?.trim() || null,
    suggestedCutList: [
      ...new Set((input.suggestedCutList ?? []).map((item) => item.trim()).filter(Boolean)),
    ],
    recoveryRequired: input.recoveryRequired,
    createdAt: input.createdAt,
  };

  // 守卫 2：出口——产出 packet 同样不得夹带执行指令。
  assertNoEngineTrigger(packet);
  return packet;
}
