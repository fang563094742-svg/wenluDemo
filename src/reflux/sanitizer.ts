/**
 * 技能反哺（Skill Reflux）· Sanitizer（脱敏，sanitizer.ts）
 * ------------------------------------------------------------------
 * 定位：`skill-flywheel` 一期脱敏能力的二期反哺扩展（Req 5）。
 *
 * **复用一期脱敏内核，不另起一套逻辑**：
 *  - 复用 `skill-flywheel` 的**值/结构分离**（`${var}` 占位，由 `distillSkill` 在蒸馏阶段完成）；
 *  - 复用 `skill-flywheel` 的 **`scanResidualPrivacy`** 去隐私校验，作为判定"是否残留可识别个人信息"的唯一内核。
 *
 * 在内核之上**扩展**（这是二期相对一期的增量）：
 *  - 剔除来自 `understand_user`、userModel 与针对具体主人的个人 beliefs 的内容（Req 5.1/5.3）；
 *  - 输出 `removed_fields` + `scanResidualPrivacy` 判定供审计（Req 5.4）；
 *  - `scanResidualPrivacy` 判定 `clean=false` → 拒绝候选、不进去重阶段（Req 5.2）。
 *
 * 纯函数、无副作用：输入候选草稿与其结构化 SkillSpec，输出"通过(已脱敏) / 拒绝"两态及审计信息。
 *
 * _Requirements: 5.1, 5.2, 5.3, 5.4_
 */

import { scanResidualPrivacy, type SkillSpec } from "../skill-flywheel/index.js";

/**
 * 个人内容字段模式：凡草稿字段键命中以下任一模式，即视为来自
 * `understand_user`/userModel/对具体主人的个人 beliefs，应整字段剔除（Req 5.1/5.3）。
 * 仅匹配"对特定主人的理解"，不误伤可泛化的方法/步骤/命令字段。
 */
const PERSONAL_FIELD_PATTERNS: RegExp[] = [
  /understand_?user/i, // understand_user / understandUser
  /user_?model/i, // userModel / user_model
  /\bbeliefs?\b/i, // belief / beliefs（对主人的判断）
  /\bpersona\b/i, // persona（人物画像）
  /user_?profile/i, // userProfile / user_profile
  /about_?(the_?)?user/i, // aboutUser / about_the_user
  /owner_?(profile|note|trait|belief|preference)/i, // 对具体主人的画像/偏好
  /personal_?(trait|note|preference|belief|profile)/i, // 个人特质/偏好/理解
];

/** 判断一个字段键是否属于"对具体主人的个人理解"。 */
function isPersonalKey(key: string): boolean {
  return PERSONAL_FIELD_PATTERNS.some((re) => re.test(key));
}

/**
 * 递归剔除草稿中"对具体主人的个人理解"字段。
 * - 命中个人内容键 → 整字段移除，并按 `a.b.c` 形式记录被移除路径供审计。
 * - 否则递归进入嵌套对象/数组，保留可泛化内容。
 * 返回新对象（不修改入参），以及被移除字段的路径列表。
 */
function stripPersonalFields(
  value: unknown,
  pathPrefix = "",
  removed: string[] = [],
): { cleaned: unknown; removed: string[] } {
  // 数组：逐元素递归（数组索引不计入个人键判断）。
  if (Array.isArray(value)) {
    const cleanedArr = value.map((item, i) => {
      const childPath = pathPrefix ? `${pathPrefix}[${i}]` : `[${i}]`;
      return stripPersonalFields(item, childPath, removed).cleaned;
    });
    return { cleaned: cleanedArr, removed };
  }

  // 普通对象：逐键判断；命中个人键整字段剔除，否则递归。
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const childPath = pathPrefix ? `${pathPrefix}.${k}` : k;
      if (isPersonalKey(k)) {
        removed.push(childPath);
        continue; // 整字段剔除，不保留对主人的理解（Req 5.3）。
      }
      out[k] = stripPersonalFields(v, childPath, removed).cleaned;
    }
    return { cleaned: out, removed };
  }

  // 标量：原样保留。
  return { cleaned: value, removed };
}

/** 脱敏审计信息（Req 5.4）：被移除字段 + `scanResidualPrivacy` 判定。 */
export interface SanitizeAudit {
  /** 去隐私内核 `scanResidualPrivacy` 的判定结果（clean + 泄露明细）。 */
  scan: { clean: boolean; leaks: string[] };
  /** 被剔除的个人内容字段路径（来自 understand_user/userModel/个人 beliefs）。 */
  removed_fields: string[];
}

/** Sanitizer 输入：蒸馏产出的结构化技能 + 其二期扩展草稿（可能夹带个人理解）。 */
export interface SanitizeInput {
  /**
   * 蒸馏产出的结构化技能规格（已由 `distillSkill` 完成值/结构分离 `${var}` 占位）。
   * `scanResidualPrivacy` 以它为去隐私校验对象。
   */
  skill: SkillSpec;
  /**
   * 二期在 `SkillSpec` 之上扩展的草稿字段（title/description/applicable_scenario/
   * kind/user_neutral 等，可能夹带来自 understand_user/userModel 的个人理解）。
   */
  draft?: Record<string, unknown>;
}

/** Sanitizer 输出：通过(已脱敏) / 拒绝；两态均带审计信息（Req 5.4）。 */
export type SanitizeResult =
  | {
      ok: true;
      /** 去隐私校验通过的技能规格（原样透传，值/结构分离已在蒸馏阶段完成）。 */
      skill: SkillSpec;
      /** 已剔除个人理解字段后的草稿。 */
      draft: Record<string, unknown>;
      audit: SanitizeAudit;
    }
  | {
      ok: false;
      /** 拒绝原因（残留隐私 / 内核异常）。 */
      reason: string;
      audit: SanitizeAudit;
    };

/**
 * 脱敏：复用 `scanResidualPrivacy` 去隐私内核 + 扩展剔除个人理解字段。
 *
 * 流程：
 *  1. 扩展剔除：从草稿中剥离来自 understand_user/userModel/个人 beliefs 的字段（记 removed_fields）。
 *  2. 去隐私内核：对结构化 `skill` 调 `scanResidualPrivacy` 判定是否残留可识别个人信息。
 *  3. `clean=false` → 拒绝候选、不进去重（Req 5.2）；`clean=true` → 通过，返回脱敏后草稿。
 *  无论通过与否，均输出 `removed_fields` + scan 判定供审计（Req 5.4）。
 *
 * fail-open：内核异常时按"拒绝"处理（宁缺毋滥，绝不让疑似含隐私的候选漏进公共池）。
 */
export function sanitizeCandidate(input: SanitizeInput): SanitizeResult {
  // 扩展剔除个人理解字段（即便后续因隐私残留被拒，也要记录已剔除字段供审计）。
  const { cleaned, removed } = stripPersonalFields(input?.draft ?? {});
  const removed_fields = removed;
  const cleanedDraft = (cleaned ?? {}) as Record<string, unknown>;

  // 去隐私内核：复用 scanResidualPrivacy，不另起一套脱敏逻辑（Req 5.1）。
  let scan: { clean: boolean; leaks: string[] };
  try {
    scan = scanResidualPrivacy(input?.skill as SkillSpec);
  } catch (err) {
    // 内核异常 → fail-closed 拒绝，附审计（removed_fields 已收集）。
    return {
      ok: false,
      reason: `去隐私内核异常，保守拒绝：${err instanceof Error ? err.message : String(err)}`,
      audit: { scan: { clean: false, leaks: [] }, removed_fields },
    };
  }

  const audit: SanitizeAudit = { scan, removed_fields };

  // 残留可识别个人信息 → 拒绝候选、不进去重阶段（Req 5.2）。
  if (!scan.clean) {
    return {
      ok: false,
      reason: `去隐私校验未通过（scanResidualPrivacy clean=false），拒绝候选：${scan.leaks.join("; ")}`,
      audit,
    };
  }

  // 通过：仅保留可泛化方法/步骤/命令，个人理解已剔除（Req 5.3）。
  return { ok: true, skill: input.skill, draft: cleanedDraft, audit };
}
