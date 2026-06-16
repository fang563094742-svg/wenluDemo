/**
 * 反哺管线 LLM 适配层（riverMain 注入入口）
 * ------------------------------------------------------------------
 * 把通用的 `LLM_Provider`（ResilientLlm / BrokerLlmProvider / Gpt54Provider）
 * 包装成反哺四个 LLM 注入角色：
 *   - DistillClassifier  (distiller.ts 的 LLM 蒸馏扩展判定)
 *   - TopKPicker         (dispatcher.ts 的 LLM top-k 精排)
 *   - DedupSemanticJudge (deduplicator.ts 的语义比对)
 *   - SoftSkillReviewer  (verifier.ts 的软技能评审)
 *
 * 设计要点：
 *  - 每个角色独立调用 LLM, 失败 fail-open 走确定性降级（不抛错, 不阻塞主链）
 *  - 单条调用 timeout 6s, 防止反哺把主呼吸卡住
 *  - prompt 极简 + 强制 JSON 输出, 解析失败也走降级
 *
 * 注入入口: riverMain 启动时调 `injectRefluxLlm(llmProvider)` 一次.
 *
 * _Requirements: 20.2 (LLM 注入便于 mock), 20.3 (按预算扣额, 失败降级)_
 */

import type { LLM_Provider } from "../llm/llmProvider.js";
import type { DistillClassifier, DistillClassifyInput, DistillExtension } from "./distiller.js";
import type { TopKPicker } from "./dispatcher.js";
import type { DedupSemanticJudge, SemanticView } from "./deduplicator.js";
import type { SoftSkillReviewer, SoftSkillReviewInput } from "./verifier.js";
import type { SkillKind, SkillSummary } from "./types.js";

/** 蒸馏分类器 LLM 输出 kind 字段的本地类型别名 (与 SkillKind 同源). */
type SkillKindLite = SkillKind;

let _llm: LLM_Provider | null = null;

/** 由 riverMain bootstrap 注入. 缺省/失败时不调 LLM, 走确定性降级. */
export function injectRefluxLlm(provider: LLM_Provider | null | undefined): void {
  _llm = provider ?? null;
}

export function getRefluxLlm(): LLM_Provider | null {
  return _llm;
}

const TIMEOUT_MS = 6000;

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    p.then((v) => v as T | null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

function safeJson(text: string): unknown {
  try {
    const cleaned = text.replace(/```json|```/g, "").trim();
    return JSON.parse(cleaned);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {}
    }
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────
// 1. DistillClassifier (蒸馏扩展判定)
// ─────────────────────────────────────────────────────────────────
export function createLlmDistillClassifier(): DistillClassifier {
  return {
    async classify(input: DistillClassifyInput): Promise<DistillExtension> {
      const llm = _llm;
      // 确定性降级 ext (与 distiller.ts 内部 deterministicExtension 等价的最小版).
      const fallback = (): DistillExtension => ({
        kind: input.hasTrajectory ? "executable" : "soft",
        applicable_scenario: input.skill.when?.taskPattern || input.goal,
        user_neutral: true,
        taxonomy: input.skill.taxonomy,
        platform: input.skill.platform?.[0],
        platform_variant: undefined,
      });
      if (!llm) return fallback();

      const sys = `你是反哺管线的蒸馏扩展判定器. 给定一条候选技能, 判定:
1. kind: "soft"(纯文本规则/思路) 或 "executable"(有可执行命令链)
2. applicable_scenario: 这条技能适用的场景一句话 (供其他用户复用时一眼看懂)
3. user_neutral: true(任意用户都能用) / false(强烈依赖具体用户的身份/凭证/路径)
只输出 JSON: {"kind":"soft"|"executable","applicable_scenario":"...","user_neutral":true/false}`;
      const skillName = (input.skill?.name ?? "").toString();
      const skillTaskPattern = (input.skill?.when?.taskPattern ?? "").toString();
      const userMsg = `goal: ${input.goal}
skill name: ${skillName}
skill task pattern: ${skillTaskPattern}
\u6709\u8F68\u8FF9\u8BC1\u636E: ${input.hasTrajectory ? "yes" : "no"}
\u6E90\u4FE1\u53F7\u89D2\u8272: ${input.signalRole}
\u6E90\u5DE5\u5177: ${input.sourceTool}`;
      try {
        const resp = await withTimeout(
          llm.complete({ system: sys, messages: [{ role: "user", content: userMsg }] }),
          TIMEOUT_MS,
        );
        if (!resp) throw new Error("timeout");
        const j = safeJson((resp as { text?: string }).text ?? "") as Record<string, unknown> | null;
        if (!j || typeof j !== "object") throw new Error("parse failed");
        const kind: SkillKindLite =
          j.kind === "soft" || j.kind === "executable"
            ? j.kind
            : input.hasTrajectory
              ? "executable"
              : "soft";
        const user_neutral = typeof j.user_neutral === "boolean" ? j.user_neutral : true;
        const applicable_scenario =
          typeof j.applicable_scenario === "string"
            ? j.applicable_scenario
            : input.skill.when?.taskPattern || input.goal;
        return {
          kind,
          applicable_scenario,
          user_neutral,
          taxonomy: input.skill.taxonomy,
          platform: input.skill.platform?.[0],
          platform_variant: undefined, // 让 distiller 内核在 deterministic 路径或自身派生
        };
      } catch {
        return fallback();
      }
    },
  };
}

// ─────────────────────────────────────────────────────────────────
// 2. TopKPicker (LLM 精排)
// ─────────────────────────────────────────────────────────────────
export function createLlmTopKPicker(): TopKPicker {
  return {
    async pick(input: { query?: string; candidates: SkillSummary[]; topK: number }): Promise<string[]> {
      const llm = _llm;
      const cands = input.candidates ?? [];
      const topK = Math.max(1, Math.min(input.topK, cands.length));
      if (!llm || cands.length <= topK) {
        return cands.slice(0, topK).map((c) => c.id);
      }
      const list = cands
        .map((c, i) => `${i + 1}. id=${c.id} | name=${c.name} | tags=[${(c.tags ?? []).join(",")}] | qs=${c.quality_score?.toFixed?.(2) ?? "0"}`)
        .join("\n");
      const sys = `你是反哺管线的检索精排器. 从下面候选里挑出最匹配查询的 ${topK} 条 (按相关性降序).
只输出 JSON 数组: ["id1","id2",...]`;
      const userMsg = `查询: ${input.query ?? "(无显式查询)"}\n候选:\n${list}`;
      try {
        const resp = await withTimeout(
          llm.complete({ system: sys, messages: [{ role: "user", content: userMsg }] }),
          TIMEOUT_MS,
        );
        if (!resp) throw new Error("timeout");
        const j = safeJson((resp as { text?: string }).text ?? "");
        if (!Array.isArray(j)) throw new Error("not array");
        const validIds = new Set(cands.map((c) => c.id));
        const picked = (j as unknown[])
          .filter((x): x is string => typeof x === "string" && validIds.has(x))
          .slice(0, topK);
        if (picked.length === 0) throw new Error("no valid id");
        return picked;
      } catch {
        return cands
          .slice()
          .sort((a, b) => (b.quality_score ?? 0) - (a.quality_score ?? 0))
          .slice(0, topK)
          .map((c) => c.id);
      }
    },
  };
}

// ─────────────────────────────────────────────────────────────────
// 3. DedupSemanticJudge (语义比对)
// ─────────────────────────────────────────────────────────────────
export function createLlmDedupSemanticJudge(): DedupSemanticJudge {
  return {
    async compare(
      a: SemanticView,
      b: SemanticView,
    ): Promise<{ relation: "duplicate" | "distinct" | "ambiguous" }> {
      const llm = _llm;
      if (!llm) {
        // 无 LLM 时退回 distinct, 让 deduplicator 走自身确定性 jaccard 回退路径.
        return { relation: "distinct" };
      }
      const sys = `你是反哺管线的语义比对器. 比对两条软技能的关系, 三选一:
- "duplicate" 实质等价 (做同一件事, 措辞不同)
- "distinct" 不同/无关
- "ambiguous" 强相似但不能完全确定 (做相近事, 留待更多证据)
只输出 JSON: {"relation":"...","reason":"一句话"}`;
      const userMsg = `A:
title: ${a.title}
description: ${a.description}
category: ${a.category ?? ""}
tags: [${(a.tags ?? []).join(",")}]

B:
title: ${b.title}
description: ${b.description}
category: ${b.category ?? ""}
tags: [${(b.tags ?? []).join(",")}]`;
      try {
        const resp = await withTimeout(
          llm.complete({ system: sys, messages: [{ role: "user", content: userMsg }] }),
          TIMEOUT_MS,
        );
        if (!resp) throw new Error("timeout");
        const j = safeJson((resp as { text?: string }).text ?? "") as Record<string, unknown> | null;
        if (!j) throw new Error("parse");
        const relation =
          j.relation === "duplicate" || j.relation === "distinct" || j.relation === "ambiguous"
            ? j.relation
            : "distinct";
        return { relation };
      } catch {
        return { relation: "distinct" };
      }
    },
  };
}

// ─────────────────────────────────────────────────────────────────
// 4. SoftSkillReviewer (软技能评审)
// ─────────────────────────────────────────────────────────────────
export function createLlmSoftSkillReviewer(): SoftSkillReviewer {
  return {
    async review(input: SoftSkillReviewInput): Promise<{ score: number; pass?: boolean; reason?: string }> {
      const llm = _llm;
      if (!llm) {
        return { score: 0.5, reason: "fallback: no llm injected" };
      }
      const sys = `你是反哺管线的软技能评审器 (无可执行体). 给定一条软技能(纯文本规则/思路), 评定其品质:
- score: 0-1, 越高越值得入库供其他用户复用
- 重点考虑: 是否真有用 / 是否能被其他用户用 / 是否避免误导
只输出 JSON: {"score":0-1,"reason":"一句话"}`;
      const userMsg = `title: ${input.title}
description: ${input.description}
${input.applicable_scenario ? `applicable_scenario: ${input.applicable_scenario}` : ""}`;
      try {
        const resp = await withTimeout(
          llm.complete({ system: sys, messages: [{ role: "user", content: userMsg }] }),
          TIMEOUT_MS,
        );
        if (!resp) throw new Error("timeout");
        const j = safeJson((resp as { text?: string }).text ?? "") as Record<string, unknown> | null;
        if (!j) throw new Error("parse");
        const score =
          typeof j.score === "number" && j.score >= 0 && j.score <= 1 ? j.score : 0.5;
        return { score, reason: typeof j.reason === "string" ? j.reason : undefined };
      } catch {
        return { score: 0.5, reason: "llm-failed-fallback" };
      }
    },
  };
}
