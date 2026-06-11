/**
 * 河床系统（Riverbed System）· 域映射与兜底汇聚（Riverbed Sense）
 * ------------------------------------------------------------------
 * 这是河床的"被动兜底"路径，与"LLM 主动写 add_riverbed_judgement"互补。
 * 在反思层每 8 轮把 mind 里已有的 belief / userModel 按 14 域映射，自动
 * 汇聚成判断包，防止 LLM 长期不主动调工具导致河床枯死。
 *
 * 两个职责，都是确定性纯函数（可单测、可属性测试）：
 *   1. `mapToRiverbedDomain`：把 belief.dimension / userModel.aspect 投影到 14 域。
 *      确定性 Record 映射表，同输入恒等输出，未知值回退 D9_COGNITION（认知域兜底）。
 *   2. `senseRiverbedFromMind`：仅基于 mind 已有结构化数据产出判断包，绝不调用 LLM。
 *
 * 关键不变量——确定性（Property 6 / Requirement 10.2）：
 *   - 映射表无随机、无时间依赖。
 *   - 汇聚的 `createdAt` 由 `cycle` 稳定推导，不用 `new Date()`，以保证
 *     同一 mind + 同一 cycle 恒产出语义相同（含 packetId）的判断包。
 *
 * 绝对边界（requirements.md Requirement 14）：
 *   - 不 import 任何 3.1 / 3.2 路径的代码。
 *   - 不 import `node:sqlite`、不写 `import "server-only"`、不用 `@/lib/` 别名。
 *   - 不调用 LLM、不开网络、不读环境变量。
 *   - 纯 TypeScript ESM，相对导入一律带 `.js` 扩展。
 *
 * _Requirements: 10.1, 10.2, 10.3, 10.4_
 */

import type { MindLike } from "./riverbed-util.js";
import type { RiverbedDomainId } from "./riverbed-domain.js";
import type {
  DomainJudgementPacket,
  DomainJudgementSeverity,
} from "./domain-judgement-packet.js";
import { buildDomainJudgementPacket } from "./domain-judgement-packet.js";

/** 映射表兜底域：未知 dimension / aspect 一律回退到认知域。 */
const FALLBACK_DOMAIN: RiverbedDomainId = "D9_COGNITION";

/**
 * belief.dimension → 14 域的确定性映射表。
 * 维度取值（弟弟既有 5 维）：direction / value / pattern / state / identity。
 */
const BELIEF_DIMENSION_TO_DOMAIN: Readonly<Record<string, RiverbedDomainId>> = {
  direction: "D0_ASPIRATION", // 方向性 → 志向（长程牵引力）
  value: "D13_VALUE", // 价值取向 → 价值域
  pattern: "D4_BEHAVIOR", // 行为模式 → 行为域
  state: "D7_ENERGY", // 状态 → 能量/容量/节奏
  identity: "D1_IDENTITY", // 自我定义 → 身份域
};

/**
 * userModel.aspect → 14 域的确定性映射表。
 * 切面取值（弟弟既有 6 aspect）：
 * boundary / value / communication-style / emotional-need / identity / goal。
 */
const USERMODEL_ASPECT_TO_DOMAIN: Readonly<Record<string, RiverbedDomainId>> = {
  boundary: "D10_RELATIONSHIP", // 人际边界 → 关系域
  value: "D13_VALUE", // 价值 → 价值域
  "communication-style": "D9_COGNITION", // 沟通风格 → 认知域
  "emotional-need": "D8_EMOTION", // 情感需求 → 情绪域
  identity: "D1_IDENTITY", // 身份 → 身份域
  goal: "D2_GOAL", // 目标 → 目标域
};

/**
 * 把 belief.dimension / userModel.aspect 映射到 14 域之一。
 *
 * 确定性纯函数（无随机、无时间依赖）：
 *  - belief：按 `BELIEF_DIMENSION_TO_DOMAIN` 查表。
 *  - userModel：按 `USERMODEL_ASPECT_TO_DOMAIN` 查表。
 *  - 未知 dimension / aspect → 回退 `D9_COGNITION`（认知域兜底）。
 *
 * 同输入恒等输出（Requirement 10.2）；返回值恒 ∈ RIVERBED_DOMAIN_IDS（Property 6）。
 *
 * @param source belief 维度或 userModel 切面的判别联合
 * @returns 对应的 RiverbedDomainId（未知值回退 D9_COGNITION）
 */
export function mapToRiverbedDomain(
  source:
    | { kind: "belief"; dimension: string }
    | { kind: "userModel"; aspect: string },
): RiverbedDomainId {
  if (source.kind === "belief") {
    return lookupDomain(BELIEF_DIMENSION_TO_DOMAIN, source.dimension);
  }
  return lookupDomain(USERMODEL_ASPECT_TO_DOMAIN, source.aspect);
}

/**
 * 自有属性安全查表：仅当 `key` 是映射表的自有属性时取值，否则回退 `FALLBACK_DOMAIN`。
 *
 * 用 `Object.prototype.hasOwnProperty.call` 判定，避免命中原型链上的继承属性
 * （如 `"toString"`、`"constructor"`、`"hasOwnProperty"`、`"valueOf"` 等）——
 * 普通对象字面量上 `table["toString"]` 会返回继承的函数，使 `?? FALLBACK_DOMAIN`
 * 失效并漏出非 RiverbedDomainId 的值，违反 Property 6（映射全域闭合）。
 *
 * 保持确定性纯函数语义不变：对任意字符串输入恒返回 14 域之一。
 */
function lookupDomain(
  table: Readonly<Record<string, RiverbedDomainId>>,
  key: string,
): RiverbedDomainId {
  return Object.prototype.hasOwnProperty.call(table, key)
    ? table[key]
    : FALLBACK_DOMAIN;
}

/**
 * 由置信度确定性推导严重度。
 * 阈值固定、单调（无随机、无时间依赖），同 confidence 恒得同 severity。
 *
 *  - confidence ≥ 0.8 → high
 *  - confidence ≥ 0.6 → medium
 *  - confidence ≥ 0.3 → low
 *  - 其余（含 NaN / 负数）→ none
 */
function severityFromConfidence(confidence: number): DomainJudgementSeverity {
  if (confidence >= 0.8) return "high";
  if (confidence >= 0.6) return "medium";
  if (confidence >= 0.3) return "low";
  return "none";
}

/**
 * 由 cycle 稳定推导 `createdAt` 占位串。
 * 不用 `new Date()`——以保证同一 cycle 的汇聚恒产出语义相同（含 packetId）的包，
 * 满足确定性（Requirement 10.2 / Property 6 / task 8.3）。
 */
function deterministicCreatedAt(cycle: number): string {
  return `riverbed-sense:cycle-${cycle}`;
}

/**
 * 从 mind 已有结构化数据兜底汇聚判断包（不调 LLM，确定性纯函数）。
 *
 * 算法：
 *  1. 遍历 `mind.beliefs`，各自 `mapToRiverbedDomain({kind:"belief"})` 得 domain；
 *     用 `buildDomainJudgementPacket` 构建 targetObjectType="belief" 的判断包，
 *     evidenceRefs 反向引用该 belief（kind:"belief" + refId:belief.id）。
 *  2. 遍历 `mind.userModel`，同理得 targetObjectType="userModel" 的判断包，
 *     evidenceRefs 反向引用该 userModel（kind:"userModel" + refId:insight.id）。
 *
 * 每条判断包统一为"被动信号观察"：judgementType="signal"、verdict="observe"、
 * constraintLevel="ADVISORY"、severity 由 confidence 确定性推导、freshness="fresh"、
 * score/confidence 用源 confidence（builder 内 clamp01）、createdAt 由 cycle 稳定推导。
 *
 * 绝不调用 LLM、不开网络、不读时钟——仅消费入参 mind（Requirement 10.4）。
 *
 * @param mind 河床读取所需的最小 mind 形状
 * @param cycle 当前轮次（用于稳定推导 createdAt，保证确定性）
 * @returns 汇聚出的判断包列表（先 belief 后 userModel，保留各自原始顺序）
 */
export function senseRiverbedFromMind(
  mind: MindLike,
  cycle: number,
): DomainJudgementPacket[] {
  const createdAt = deterministicCreatedAt(cycle);
  const packets: DomainJudgementPacket[] = [];

  for (const belief of mind.beliefs) {
    const domain = mapToRiverbedDomain({
      kind: "belief",
      dimension: belief.dimension,
    });
    packets.push(
      buildDomainJudgementPacket({
        domain,
        targetObjectType: "belief",
        targetObjectId: belief.id,
        targetSummary: belief.content,
        judgementType: "signal",
        score: belief.confidence,
        confidence: belief.confidence,
        severity: severityFromConfidence(belief.confidence),
        verdict: "observe",
        reason: `兜底汇聚自 belief「${belief.dimension}」`,
        freshness: "fresh",
        constraintLevel: "ADVISORY",
        evidenceRefs: [
          { kind: "belief", refId: belief.id, refRole: "supporting" },
        ],
        suggestedNextStep: null,
        suggestedCutList: [],
        recoveryRequired: false,
        createdAt,
      }),
    );
  }

  for (const insight of mind.userModel) {
    const domain = mapToRiverbedDomain({
      kind: "userModel",
      aspect: insight.aspect,
    });
    packets.push(
      buildDomainJudgementPacket({
        domain,
        targetObjectType: "userModel",
        targetObjectId: insight.id,
        targetSummary: insight.content,
        judgementType: "signal",
        score: insight.confidence,
        confidence: insight.confidence,
        severity: severityFromConfidence(insight.confidence),
        verdict: "observe",
        reason: `兜底汇聚自 userModel「${insight.aspect}」`,
        freshness: "fresh",
        constraintLevel: "ADVISORY",
        evidenceRefs: [
          { kind: "userModel", refId: insight.id, refRole: "supporting" },
        ],
        suggestedNextStep: null,
        suggestedCutList: [],
        recoveryRequired: false,
        createdAt,
      }),
    );
  }

  return packets;
}
