/**
 * 测试工厂：构造合法 SkillSpec（默认去隐私干净）。
 */
import { type SkillSpec, newSkillId } from "../skill-spec.js";

export function mkSkill(over: Partial<SkillSpec> = {}): SkillSpec {
  const base: SkillSpec = {
    id: newSkillId(),
    name: "打开下棋应用并走一步",
    when: { taskPattern: "下棋 走子 chess move", preconditions: [] },
    exec: { vars: ["path1"], steps: [{ op: "open", args: { a1: "${path1}" } }, { op: "move", args: { a1: "e2e4" } }] },
    done: "目标达成",
    verify: { kind: "state-assert", spec: "board changed" },
    platform: ["mac"],
    platformLocked: true,
    taxonomy: { taskType: "game", app: "chess" },
    provenance: { createdAt: new Date().toISOString(), verifiedCount: 1, totalCount: 1 },
  };
  return {
    ...base,
    ...over,
    when: { ...base.when, ...(over.when ?? {}) },
    exec: { ...base.exec, ...(over.exec ?? {}) },
    verify: { ...base.verify, ...(over.verify ?? {}) },
    taxonomy: { ...base.taxonomy, ...(over.taxonomy ?? {}) },
    provenance: { ...base.provenance, ...(over.provenance ?? {}) },
  };
}
