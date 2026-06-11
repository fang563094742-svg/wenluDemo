/**
 * 认知核三段脊柱 · 向后兼容逐字节硬覆盖断言（任务 7.2 · 最高约束·不可跳过）
 * ------------------------------------------------------------------
 * 对一组**固定输入集**，在缺省 `mode="dry-run"`（由缺省 mind 经
 * `resolveCognitiveConfig` 回退到 `DEFAULT_COGNITIVE_CORE` 得到）下，
 * 断言认知核三段脊柱的对外出口与"未接脊柱时"逐字节零改变：
 *
 *  - `condense(...)` 在 dry-run 下 `Output.status === "suppressed"`，且其
 *    `text` 不被用于替换原文 —— 通过"原文经认知核后字节序列恒等于原文"
 *    建模 emit 出口字节零改变（验证 output-kernel 的 dry-run 红线）。
 *  - `planFromContext(ctx)` 在 dry-run 下产出 `Intent.mode === "dry-run"`、
 *    `Intent.status` 停在 `"planned"`（不越过、不落地执行、不外溢）。
 *  - 用 fast-check 跑固定输入集 + 随机输入，断言 dry-run 下 `Output` 终态
 *    恒为 `suppressed`、`Intent.status` 恒为 `planned`。
 *
 * 这是 **Property 3（dry-run 零外溢）/ Property 12（配置向后兼容）** 的
 * 端到端佐证。
 * **Validates: Requirements 5.2, 5.3**
 *
 * 绝对边界（铁律）：
 *  - 仅 import vitest / fast-check 与对外 barrel `../index.js`（公共 API）。
 *  - **绝不** import / 读 / 跑 riverMain.ts、3.1 后端、3.2 任何路径。
 *  - 不 import node:sqlite、不用 @/lib 别名。不改任何实现。
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";

import {
  planFromContext,
  condense,
  resolveCognitiveConfig,
  DEFAULT_COGNITIVE_CORE,
  type CognitiveCoreConfig,
  type Intent,
  type MindConfigReadLike,
  type NodeSignal,
  type OutputContext,
  type PlanContext,
} from "../index.js";

// ─── 缺省配置：缺省 mind 回退 DEFAULT_COGNITIVE_CORE（mode="dry-run"） ──

/**
 * 模拟"未接脊柱时"的缺省 mind：不含 `cognitiveCore` 字段。
 * 经 `resolveCognitiveConfig` 回退到 `DEFAULT_COGNITIVE_CORE`（mode="dry-run"）。
 */
const DEFAULT_MIND: MindConfigReadLike = {};

/** 缺省 mind 解析出的认知核配置（缺省 = dry-run 观察模式，零行为改变）。 */
const DEFAULT_CONFIG: CognitiveCoreConfig = resolveCognitiveConfig(DEFAULT_MIND);

// ─── 固定输入集（覆盖典型对外触发场景） ──────────────────────

/** 固定用户话术输入集（含中文、英文、空话、长文、工程态黑话等典型形态）。 */
const FIXED_UTTERANCES: ReadonlyArray<string> = [
  "帮我把这周的进展整理成一段汇报",
  "写一个能抓取价格的小工具",
  "我想和投资人对齐下个季度的目标",
  "这个方案你来拍板",
  "随便聊聊",
  "Please summarize the latest changes",
  "exit code 0 / MD5 校验通过 / FEN 已落库", // 工程态黑话场景
  "", // 空话场景
  "把这件超长的事拆开：先调研，再设计，再实现，再验证，最后凝练成人话汇报给用户，并确保每一步都有验收线",
];

/** 固定节点信号输入集（覆盖 4 种 kind + 不同 summary）。 */
const FIXED_SIGNALS: ReadonlyArray<NodeSignal> = [
  { kind: "done", summary: "已完成核心交付物" },
  { kind: "blocked", summary: "卡在依赖未就绪" },
  { kind: "needs_user", summary: "需要你确认方向" },
  { kind: "progress", summary: "推进中（不应外溢）" },
  { kind: "done", summary: "" }, // 缺摘要兜底场景
];

// ─── 构造缺省 dry-run 上下文（从缺省 mind 派生，杜绝硬编码 mode） ──

/** 从缺省配置构造规划核上下文（mode 透传缺省 config.mode = "dry-run"）。 */
function makePlanContext(utterance: string): PlanContext {
  return {
    userUtterance: utterance === "" ? null : utterance,
    recentConversation: [],
    mode: DEFAULT_CONFIG.mode,
  };
}

/** 从缺省配置构造输出核上下文（mode / budget 全部取自缺省 config）。 */
function makeOutputContext(): OutputContext {
  return {
    mode: DEFAULT_CONFIG.mode,
    outputCharBudget: DEFAULT_CONFIG.outputCharBudget,
  };
}

/** 最小 Intent 构造（供 condense 溯源；mode 取缺省 dry-run）。 */
function makeIntent(goal: string): Intent {
  return {
    id: "intent_bc_fixed",
    sourceUtterance: null,
    goal,
    subgoals: [],
    expectedResult: "预期结果",
    acceptanceLine: "验收线",
    status: "planned",
    createdAt: "2026-01-01T00:00:00.000Z",
    mode: DEFAULT_CONFIG.mode,
  };
}

// ═══════════════════════════════════════════════════════════════
// 前置：缺省 mind 必须落在 dry-run（向后兼容地基 · Property 12）
// ═══════════════════════════════════════════════════════════════

describe("向后兼容地基 · 缺省 mind 回退 dry-run (Property 12, Req 5.2)", () => {
  it("缺省 mind（无 cognitiveCore）解析出的 config 深度等于 DEFAULT_COGNITIVE_CORE", () => {
    expect(DEFAULT_CONFIG).toEqual(DEFAULT_COGNITIVE_CORE);
  });

  it("缺省 config.mode === 'dry-run'（观察模式，零行为改变前提）", () => {
    expect(DEFAULT_CONFIG.mode).toBe("dry-run");
  });

  it("resolveCognitiveConfig 不修改入参 mind", () => {
    const mind: MindConfigReadLike = {};
    resolveCognitiveConfig(mind);
    expect(mind).toEqual({});
  });
});

// ═══════════════════════════════════════════════════════════════
// A. planFromContext dry-run：Intent.mode='dry-run' 且 status 停在 'planned'
// ═══════════════════════════════════════════════════════════════

describe("planFromContext dry-run · Intent 停在 planned (Property 12, Req 5.2/5.3)", () => {
  it("固定输入集：每条 utterance 产出 Intent.mode='dry-run' 且 status='planned'", async () => {
    for (const utterance of FIXED_UTTERANCES) {
      const ctx = makePlanContext(utterance);
      const intent = await planFromContext(ctx);
      expect(intent.mode).toBe("dry-run");
      expect(intent.status).toBe("planned");
    }
  });

  it("随机输入：∀ utterance，dry-run 下 Intent.mode='dry-run' 且 status 恒为 'planned'", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.option(fc.string({ maxLength: 300 }), { nil: null }),
        async (utterance) => {
          const ctx: PlanContext = {
            userUtterance: utterance,
            recentConversation: [],
            mode: DEFAULT_CONFIG.mode, // 缺省 dry-run
          };
          const intent = await planFromContext(ctx);
          expect(intent.mode).toBe("dry-run");
          // dry-run 下 status 不得越过 planned（不落地执行、不外溢）。
          expect(intent.status).toBe("planned");
        },
      ),
      { numRuns: 300 },
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// B. condense dry-run：Output 终态 suppressed，且 text 不替换原文
// ═══════════════════════════════════════════════════════════════

describe("condense dry-run · Output 终态 suppressed (Property 3, Req 5.3)", () => {
  it("固定输入集：每个 (utterance × signal) 的 Output.status === 'suppressed'", async () => {
    const ctx = makeOutputContext();
    for (const utterance of FIXED_UTTERANCES) {
      const intent = makeIntent(utterance || "推进当前对话目标");
      for (const signal of FIXED_SIGNALS) {
        const out = await condense(intent, signal, ctx);
        expect(out.status).toBe("suppressed");
      }
    }
  });

  it("随机输入：∀ (goal × signal)，dry-run 下 Output.status 恒为 'suppressed'", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ maxLength: 300 }),
        fc.record({
          kind: fc.constantFrom<NodeSignal["kind"]>(
            "done",
            "blocked",
            "needs_user",
            "progress",
          ),
          summary: fc.string({ maxLength: 300 }),
        }),
        async (goal, signal) => {
          const out = await condense(
            makeIntent(goal),
            signal,
            makeOutputContext(),
          );
          expect(out.status).toBe("suppressed");
        },
      ),
      { numRuns: 300 },
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// C. 逐字节零改变：dry-run 下"原文经认知核后"emit 出口字节序列恒等原文
//    建模——suppressed 的 Output.text 绝不被用于替换原文，故出口字节零改变。
// ═══════════════════════════════════════════════════════════════

/**
 * 建模"未接脊柱时"的既有 emit 出口：直接放行原文字节。
 * 接入脊柱后，dry-run 下认知核的 condense 产出恒为 suppressed —— 即
 * 凝练文本被沉默、绝不替换原文，故 emit 出口字节序列与未接脊柱时逐字节一致。
 */
function emitThroughCognitiveCore(
  originalText: string,
  out: { status: string; text: string },
): string {
  // dry-run 红线：Output.status==="suppressed" ⟹ 凝练文本不外溢、不替换原文。
  if (out.status === "suppressed") {
    return originalText;
  }
  // 非 suppressed（enforce）才允许凝练文本替换（此分支在 dry-run 下不可达）。
  return out.text;
}

describe("逐字节零改变 · dry-run emit 出口恒等原文 (Req 5.3)", () => {
  it("固定输入集：原文经认知核后逐字节等于原文（凝练文本被沉默）", async () => {
    const ctx = makeOutputContext();
    for (const utterance of FIXED_UTTERANCES) {
      const original = utterance || "原始对外文本";
      const intent = makeIntent(original);
      for (const signal of FIXED_SIGNALS) {
        const out = await condense(intent, signal, ctx);
        const emitted = emitThroughCognitiveCore(original, out);
        // 逐字节零改变：码点序列与字节长度双重断言。
        expect(emitted).toBe(original);
        expect(Array.from(emitted)).toEqual(Array.from(original));
      }
    }
  });

  it("随机输入：∀ 原文，dry-run 下经认知核后 emit 出口逐字节恒等原文", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ maxLength: 400 }),
        fc.record({
          kind: fc.constantFrom<NodeSignal["kind"]>(
            "done",
            "blocked",
            "needs_user",
            "progress",
          ),
          summary: fc.string({ maxLength: 200 }),
        }),
        async (original, signal) => {
          const out = await condense(
            makeIntent(original || "原始对外文本"),
            signal,
            makeOutputContext(),
          );
          const emitted = emitThroughCognitiveCore(original, out);
          expect(emitted).toBe(original);
        },
      ),
      { numRuns: 300 },
    );
  });
});
