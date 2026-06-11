/**
 * 技能复利飞轮 · Component 4：轨迹蒸馏器（distiller.ts）
 * ------------------------------------------------------------------
 * 把"做成过的真实轨迹"榨成可复用、可反哺、去隐私的 SkillSpec。
 * 三道闸：
 *   ① 未 verified（客观验证未通过）→ 恒拒绝（P3 不固化错误经验）。
 *   ② 值/结构分离：把 args 里的具体隐私值替换为 ${var} 占位，vars 列出（P5）。
 *   ③ 去隐私校验：scanResidualPrivacy 不 clean → 拒绝入库（P4）。
 * 复用 execution-kernel 的 ExecutionStep，不重造轨迹类型。纯函数，无副作用。
 * _Requirements: 3.1-3.6_
 */

import type { ExecutionStep } from "../execution-kernel/index.js";
import {
  type SkillSpec,
  type SkillPlatform,
  type SkillTaxonomy,
  type SkillVerifyContract,
  type SkillExecStep,
  newSkillId,
  scanResidualPrivacy,
} from "./skill-spec.js";

export interface DistillInput {
  goal: string;
  trace: ExecutionStep[];
  verified: boolean;
  platform: SkillPlatform;
  taxonomy: SkillTaxonomy;
  verify: SkillVerifyContract;
}

export type DistillResult = { ok: true; skill: SkillSpec } | { ok: false; reason: string };

/** 隐私值 → 占位变量的抽取规则。命中则产出 (placeholder, varName)。 */
const VALUE_EXTRACTORS: Array<{ re: RegExp; varName: (i: number) => string }> = [
  { re: /\/Users\/[^/\s$]+\/[^\s$]*/g, varName: (i) => `path${i}` },
  { re: /[A-Za-z]:\\Users\\[^\\\s]+\\[^\s$]*/g, varName: (i) => `path${i}` },
  { re: /\/home\/[^/\s$]+\/[^\s$]*/g, varName: (i) => `path${i}` },
  { re: /\/Users\/[^/\s$]+/g, varName: (i) => `home${i}` },
  { re: /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, varName: (i) => `email${i}` },
  { re: /\b(?:sk|pk|ghp|xox[baprs])[-_][A-Za-z0-9]{10,}/g, varName: (i) => `token${i}` },
  { re: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, varName: (i) => `ip${i}` },
];

/** 把一段含具体隐私值的文本做值/结构分离：返回占位化文本 + 收集到的 var 名。 */
function separateValues(text: string, vars: Set<string>, counter: { n: number }): string {
  let out = text ?? "";
  for (const ex of VALUE_EXTRACTORS) {
    out = out.replace(ex.re, () => {
      const name = ex.varName(counter.n++);
      vars.add(name);
      return `\${${name}}`;
    });
  }
  return out;
}

/** 从 ExecutionStep 推断执行体单步结构（op + 占位化 args）。 */
function stepToExec(step: ExecutionStep, vars: Set<string>, counter: { n: number }): SkillExecStep {
  const action = step?.action ?? "";
  // action 形如 "op arg1 arg2" 或纯 op；首 token 作 op，其余作位置参数。
  const parts = action.trim().split(/\s+/);
  const op = parts[0] || "noop";
  const args: Record<string, string> = {};
  for (let i = 1; i < parts.length; i++) {
    args[`a${i}`] = separateValues(parts[i], vars, counter);
  }
  return { op, args };
}

/**
 * 蒸馏。未 verified 恒拒绝；值结构分离；去隐私不过拒绝。
 * 只采纳 outcome==="achieved" 的有效步骤，丢弃无效/错误步（不把错误经验固化）。
 */
export function distillSkill(input: DistillInput): DistillResult {
  try {
    if (!input) return { ok: false, reason: "空输入" };
    // 闸①：未通过客观验证 → 绝不蒸馏（P3）。
    if (input.verified !== true) {
      return { ok: false, reason: "未通过客观验证，拒绝固化（不固化错误经验）" };
    }
    const rawTrace = Array.isArray(input.trace) ? input.trace : [];
    // 只保留达成态步骤；其余（no_effect/wrong_effect/unknown）剔除。
    const effective = rawTrace.filter((s) => s?.outcome === "achieved");
    if (effective.length === 0) {
      return { ok: false, reason: "无有效达成步骤可蒸馏" };
    }

    const vars = new Set<string>();
    const counter = { n: 1 };
    const steps = effective.map((s) => stepToExec(s, vars, counter));

    // taskPattern 同样去隐私（避免目标描述里夹带隐私值）。
    const taskPattern = separateValues(input.goal ?? "", vars, counter);
    const verifySpec = separateValues(input.verify?.spec ?? "", vars, counter);

    const platformLocked = !input.platform || input.platform !== "any";

    const skill: SkillSpec = {
      id: newSkillId(),
      name: (input.goal ?? "skill").slice(0, 60),
      when: {
        taskPattern,
        preconditions: [],
      },
      exec: {
        vars: [...vars],
        steps,
      },
      done: input.verify?.spec ? `验证通过：${input.verify.kind}` : "目标达成",
      verify: {
        kind: input.verify?.kind ?? "state-assert",
        spec: verifySpec,
      },
      platform: input.platform ? [input.platform] : ["any"],
      platformLocked,
      taxonomy: {
        industry: input.taxonomy?.industry,
        app: input.taxonomy?.app,
        taskType: input.taxonomy?.taskType ?? "generic",
      },
      provenance: {
        createdAt: new Date().toISOString(),
        verifiedCount: 1, // 蒸馏自一次已验证成功的轨迹。
        totalCount: 1,
      },
    };

    // 闸③：去隐私校验（P4）。残留具体隐私值 → 拒绝入库。
    const scan = scanResidualPrivacy(skill);
    if (!scan.clean) {
      return { ok: false, reason: `去隐私校验未通过，拒绝入库：${scan.leaks.join("; ")}` };
    }

    return { ok: true, skill };
  } catch (err) {
    // fail-open：蒸馏异常 → 不入库（既有经验不丢，主链不断）。
    return { ok: false, reason: `fail-open(${err instanceof Error ? err.message : String(err)})` };
  }
}
