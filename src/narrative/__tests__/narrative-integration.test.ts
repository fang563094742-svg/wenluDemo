/**
 * 叙事输出层 · riverMain.ts say_to_user 接线集成测试（tasks.md 任务 11.3）
 * ==================================================================
 * 本测试**精确复刻** riverMain.ts 的 `say_to_user` case 接线逻辑（约 2595 行）：
 *
 *   const baseCfg = resolveNarrativeConfig(mind);
 *   const legacyPatterns = mind.fallbackReplyPolicy?.legacyPatterns ?? [];
 *   const narrCfg = legacyPatterns.length > 0
 *     ? { ...baseCfg, extraForbiddenPatterns: [...baseCfg.extraForbiddenPatterns, ...legacyPatterns] }
 *     : baseCfg;
 *   const srcIndex = buildSourceIndex(mind, Date.now());
 *   const gated = gateNarrative(text, srcIndex, narrCfg);
 *   // outText = gated.text（非空时）
 *
 * 验证项（参见 requirements.md Requirement 8.4 / 8.5）：
 *  1. 默认 mind（无 narrativeVoice ⟹ dry-run）：对一组不含 legacyPatterns 的样本文本，
 *     `gated.text === 输入文本` 逐字节相等（零回归，R8.4）。
 *  2. enforce 模式 + 文本命中 legacyPattern：通过接线的 extraForbiddenPatterns 合并，
 *     人格门判定不一致 ⟹ verdict==="reject" 且 text !== 原文（中性重述，复用既有军法，R8.5）。
 *  3. buildSourceIndex 在本 mind 上只读不改：调用前后深快照逐字段相等
 *     （确认 say_to_user 接线 read-only）。
 *
 * 框架：vitest + fast-check。相对导入一律带 `.js` 扩展、不引入未使用导入。
 */

import { describe, it, expect } from "vitest";

import {
  resolveNarrativeConfig,
  buildSourceIndex,
  gateNarrative,
  type MindReadLike,
  type NarrativeVoiceConfig,
  type NarrativeGateResult,
} from "../index.js";

// ------------------------------------------------------------------
// 接线 helper：复刻 riverMain.ts say_to_user case 的叙事门接线逻辑
// ------------------------------------------------------------------

/**
 * 复刻 riverMain.ts `say_to_user` case 的叙事门接线（最小侵入、降级安全）：
 * 解析配置 → 合并既有军法 legacyPatterns 进 extraForbiddenPatterns（不另立标准）→
 * 只读构建来源索引 → 过质量门。返回完整裁决结果（含 text / verdict）。
 */
function wireNarrative(mind: MindReadLike, text: string): NarrativeGateResult {
  const baseCfg = resolveNarrativeConfig(mind);
  const legacyPatterns = mind.fallbackReplyPolicy?.legacyPatterns ?? [];
  const narrCfg: NarrativeVoiceConfig =
    legacyPatterns.length > 0
      ? {
          ...baseCfg,
          extraForbiddenPatterns: [
            ...baseCfg.extraForbiddenPatterns,
            ...legacyPatterns,
          ],
        }
      : baseCfg;
  const srcIndex = buildSourceIndex(mind, Date.now());
  return gateNarrative(text, srcIndex, narrCfg);
}

// ------------------------------------------------------------------
// 代表性 mind 工厂（含 河床 / 时空 / knowledge / beliefs / userModel / 军法）
// ------------------------------------------------------------------

/**
 * 构造一个代表性 mind（匹配默认弟弟 mind 形状）：
 *  - knowledge：部分 web-verified、部分 inferred。
 *  - beliefs：活跃 + 被推翻（correctedBy 设置）。
 *  - userModel：活跃 + 被取代（supersededBy 设置）。
 *  - riverbed：{ nodes:[{ packet:{ reason } }] }（窄化读取器可消费）。
 *  - chronotopic：{ signatures:[{ scene, frontAppName, targetRef:{ id } }] }。
 *  - fallbackReplyPolicy.legacyPatterns：默认弟弟军法口径。
 *
 * 注意：返回新对象，避免跨用例共享可变状态。
 */
function makeRepresentativeMind(): MindReadLike {
  return {
    knowledge: [
      { content: "用户在做 iOS 上架，卡在 TestFlight 审核这步", source: "web-verified" },
      { content: "服务器部署在东京区域", source: "file-observed" },
      { content: "用户可能倾向于先做 MVP", source: "inferred" },
      { content: "预算大约五千元", source: "inferred-unverified" },
    ],
    beliefs: [
      { id: "b0", content: "当前最高优先级是通过审核", confidence: 0.8, source: "inferred" },
      {
        id: "b1",
        content: "用户已经放弃安卓端",
        confidence: 0.4,
        source: "inferred",
        correctedBy: "b0",
      },
    ],
    userModel: [
      { id: "u0", aspect: "节奏", content: "用户偏好快速迭代交付", confidence: 0.7 },
      {
        id: "u1",
        aspect: "节奏",
        content: "用户偏好慢工出细活",
        confidence: 0.5,
        supersededBy: "u0",
      },
    ],
    riverbed: {
      nodes: [
        { id: "n0", packet: { reason: "审核阻塞是当前主河道" } },
        { id: "n1", packet: { reason: "demo 交付临近 deadline" } },
      ],
    },
    chronotopic: {
      signatures: [
        { scene: "工作", frontAppName: "Xcode", targetRef: { id: "proj-ios" } },
        { scene: "沟通", frontAppName: "微信", targetRef: { id: "chat-user" } },
      ],
    },
    fallbackReplyPolicy: {
      legacyPatterns: ["嗯，我在。", "我在", "好的，我在", "收到，我在"],
    },
  };
}

/**
 * 一组**不含任何 legacyPattern**的样本文本（用于 dry-run 零回归断言）。
 * 默认 annotateMode="off"，dry-run 下恒走 pass 分支 ⟹ 文本逐字节不变。
 */
const NON_LEGACY_SAMPLE_TEXTS: ReadonlyArray<string> = [
  "你卡在 TestFlight 审核这步，我帮你梳一下下一步。",
  "服务器部署在东京区域，延迟会高一点。",
  "deadline next week, let's ship the demo first.",
  "这是一段不含旧口径的普通回复。",
  "纯提问吗？这是什么情况呢？",
  "多行文本\n第二行\r\n第三行结束。",
  "特殊字符 😀🚀\t 也要逐字节保真。",
  "x".repeat(1500),
];

// ------------------------------------------------------------------
// 1. dry-run（默认 mind 无 narrativeVoice）：既有 say 输出逐字节不变（零回归）
// Validates: Requirements 8.4
// ------------------------------------------------------------------

describe("接线 · dry-run 零回归：默认 mind 下 say 输出逐字节不变", () => {
  it("默认 mind（无 narrativeVoice ⟹ dry-run）：不含 legacy 的样本文本逐字节恒等", () => {
    const mind = makeRepresentativeMind();
    // 默认接线解析出的配置即 dry-run + annotateMode=off。
    const cfg = resolveNarrativeConfig(mind);
    expect(cfg.mode).toBe("dry-run");
    expect(cfg.annotateMode).toBe("off");

    for (const text of NON_LEGACY_SAMPLE_TEXTS) {
      const gated = wireNarrative(mind, text);
      expect(gated.verdict).toBe("pass");
      // 零回归：逐字节相等。
      expect(gated.text).toBe(text);
    }
  });

  it("dry-run 下即便文本命中 legacyPattern 也只观察、不改文本（dry-run 永不 reject）", () => {
    const mind = makeRepresentativeMind();
    const text = "嗯，我在。这是旧口径但 dry-run 只观察。";
    const gated = wireNarrative(mind, text);
    // dry-run 仅产 pass / annotate；annotateMode=off ⟹ pass，文本不变。
    expect(gated.verdict).toBe("pass");
    expect(gated.text).toBe(text);
    // 人格门仍记录命中（留痕用），但不改变既有 say 行为。
    expect(gated.persona.consistent).toBe(false);
  });
});

// ------------------------------------------------------------------
// 2. enforce 模式 + 命中 legacyPattern ⟹ reject 重述（复用军法 legacyPatterns）
// Validates: Requirements 8.5, 8.2
// ------------------------------------------------------------------

describe("接线 · enforce：命中 legacyPattern 走 reject 重述", () => {
  const enforceVoice: NarrativeVoiceConfig = {
    mode: "enforce",
    passThreshold: 0.6,
    supportThreshold: 0.34,
    lateBoost: 0.5,
    annotateMode: "off",
    extraForbiddenPatterns: [],
  };

  it("enforce + 文本含 legacyPattern「嗯，我在。」⟹ verdict=reject 且 text !== 原文", () => {
    const mind = makeRepresentativeMind();
    mind.narrativeVoice = enforceVoice;

    const original = "嗯，我在。你说的事我记下了。";
    const gated = wireNarrative(mind, original);

    // 接线把 legacyPatterns 合并进 extraForbiddenPatterns，人格门命中 ⟹ 不一致。
    expect(gated.persona.consistent).toBe(false);
    expect(gated.verdict).toBe("reject");
    // 中性重述：放行文本不再是原文（不静默篡改语义，改走重述提示）。
    expect(gated.text).not.toBe(original);
    expect(gated.text.length).toBeGreaterThan(0);
  });

  it("enforce + 文本含另一 legacyPattern「我在」⟹ reject（验证合并的每一项军法生效）", () => {
    const mind = makeRepresentativeMind();
    mind.narrativeVoice = enforceVoice;

    const original = "我在，这就帮你看 TestFlight 审核。";
    const gated = wireNarrative(mind, original);

    expect(gated.verdict).toBe("reject");
    expect(gated.text).not.toBe(original);
  });

  it("enforce + 文本不含任何 legacyPattern ⟹ 不因军法 reject（不误伤正常表达）", () => {
    const mind = makeRepresentativeMind();
    mind.narrativeVoice = enforceVoice;

    // 该句完全基于 knowledge 已有内容，且不含任何 legacy 口径。
    const original = "你卡在 TestFlight 审核这步，服务器部署在东京区域。";
    const gated = wireNarrative(mind, original);

    // 人格门一致 ⟹ 绝不会因军法走 reject（可能 pass 或低忠实度 fallback，但都放行原文）。
    expect(gated.persona.consistent).toBe(true);
    expect(gated.verdict).not.toBe("reject");
  });
});

// ------------------------------------------------------------------
// 3. buildSourceIndex 在本 mind 上只读不改（确认 say_to_user 接线 read-only）
// Validates: Requirements 8.5（接线只读，不写记忆）
// ------------------------------------------------------------------

describe("接线 · 只读：buildSourceIndex 不改 mind（say_to_user wiring read-only）", () => {
  it("代表性 mind：buildSourceIndex 调用前后深快照逐字段相等", () => {
    const mind = makeRepresentativeMind();
    const before = structuredClone(mind);
    buildSourceIndex(mind, Date.now());
    expect(mind).toEqual(before);
  });

  it("完整 wireNarrative 接线（dry-run）前后 mind 深快照不变（整条接线只读）", () => {
    const mind = makeRepresentativeMind();
    const before = JSON.stringify(mind);
    for (const text of NON_LEGACY_SAMPLE_TEXTS) {
      wireNarrative(mind, text);
    }
    const after = JSON.stringify(mind);
    expect(after).toBe(before);
  });
});
