/**
 * 河床系统（Riverbed System）· 证据 / 约束引用归一化
 * ------------------------------------------------------------------
 * 这是河床判断挂载的可追溯证据引用层。每条河床判断都能追溯到 mind 里的
 * 真实来源（belief / userModel / conversation / episode 等），杜绝凭空判断。
 *
 * 关键适配（相对 3.1 蓝本 lib/wenlu/riverbed/riverbed-evidence.ts）：
 *   - 3.1 引用 `CanonicalObjectRef`（带 sourceNamespace 的外部命名空间）。
 *     弟弟改为 `kind` + `refId` 直接指向 mind 内部已存在的实体，不引入外部命名空间。
 *   - 去掉 3.1 约束引用上的 `metadata: JsonObject`（依赖外部类型）。
 *   - source 取值从 3.1 的 `l7 | security | domain | manual`
 *     改为弟弟的 `rule | value | domain | manual`（rule 替代 l7/security）。
 *   - 沿用 3.1 的复合键去重哲学：把命名空间键换成弟弟的 `kind:refId`。
 *
 * 绝对边界（requirements.md Requirement 14）：
 *   - 不 import 任何 3.1 / 3.2 路径的代码。
 *   - 不 import `node:sqlite`、不写 `import "server-only"`、不用 `@/lib/` 别名。
 *   - 纯 TypeScript ESM，相对导入带 `.js` 扩展（本文件无内部依赖）。
 *
 * _Requirements: 6.2, 6.3, 6.4_
 */

/**
 * 证据引用：指向弟弟 mind 里已存在的实体（不引入外部命名空间）。
 *
 * `kind` 标识来源层，`refId` 是该层内已有的稳定标识：
 *   - belief        → belief.id
 *   - userModel     → userModel.id
 *   - knowledge     → knowledge.id
 *   - conversation  → conversation 索引串
 *   - episode       → episode.id
 *   - prediction    → prediction.id
 *   - manual        → 人工标注的引用标识
 */
export interface RiverbedEvidenceRef {
  /** 证据来源层（指向 mind 内部实体类型）。 */
  kind:
    | "belief"
    | "userModel"
    | "knowledge"
    | "conversation"
    | "episode"
    | "prediction"
    | "manual";
  /** 该来源层内已存在实体的稳定标识（belief.id / userModel.id / 会话索引串 等）。 */
  refId: string;
  /** 可选的人类可读标签。 */
  label?: string;
  /** 该证据相对判断的角色：支持 / 反对 / 上下文。 */
  refRole?: "supporting" | "contradicting" | "context";
}

/**
 * 约束引用：一条作用于河床判断的约束，附带其支撑证据。
 *
 * `source` 取值（弟弟语义）：
 *   - rule    规则约束（替代 3.1 的 l7 / security）
 *   - value   价值 / 主权约束
 *   - domain  领域内生约束
 *   - manual  人工标注约束
 */
export interface RiverbedConstraintRef {
  /** 约束的稳定标识。 */
  constraintId: string;
  /** 约束来源类别。 */
  source: "rule" | "value" | "domain" | "manual";
  /** 约束的中文摘要。 */
  summary: string;
  /** 支撑该约束的证据引用（同样归一化去重）。 */
  evidenceRefs: RiverbedEvidenceRef[];
}

/**
 * 证据引用的复合去重键：`kind:refId`。
 * 沿用 3.1 的复合键去重哲学，但键由弟弟内部的 kind + refId 组成。
 */
function evidenceRefKey(ref: RiverbedEvidenceRef): string {
  return `${ref.kind}:${ref.refId}`;
}

/**
 * 归一化证据引用列表：
 *  - trim `refId`，丢弃 trim 后为空的引用；
 *  - 按 `kind:refId` 复合键去重；
 *  - 保留首次出现顺序；
 *  - trim 可选 `label`（为空则省略字段），原样保留 `refRole`。
 *
 * 确定性纯函数：不修改输入，相同输入恒返回结构相同的结果。
 *
 * @param refs 任意证据引用列表（可空 / undefined）
 * @returns 归一化、去重后的证据引用列表（无两条相同复合键）
 */
export function normalizeEvidenceRefs(
  refs?: readonly RiverbedEvidenceRef[],
): RiverbedEvidenceRef[] {
  const seen = new Set<string>();
  const normalized: RiverbedEvidenceRef[] = [];
  for (const ref of refs ?? []) {
    const refId = ref.refId.trim();
    if (!refId) continue;
    const next: RiverbedEvidenceRef = {
      kind: ref.kind,
      refId,
      ...(ref.label?.trim() ? { label: ref.label.trim() } : {}),
      ...(ref.refRole ? { refRole: ref.refRole } : {}),
    };
    const key = evidenceRefKey(next);
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(next);
  }
  return normalized;
}

/**
 * 归一化约束引用列表：
 *  - trim `constraintId`，丢弃为空者；
 *  - 按 `constraintId` 去重，保留首次出现顺序；
 *  - trim `summary`；
 *  - 内部 `evidenceRefs` 同样经 `normalizeEvidenceRefs` 归一化去重。
 *
 * 确定性纯函数：不修改输入。
 *
 * @param refs 任意约束引用列表（可空 / undefined）
 * @returns 归一化、去重后的约束引用列表
 */
export function normalizeConstraintRefs(
  refs?: readonly RiverbedConstraintRef[],
): RiverbedConstraintRef[] {
  const seen = new Set<string>();
  const normalized: RiverbedConstraintRef[] = [];
  for (const ref of refs ?? []) {
    const constraintId = ref.constraintId.trim();
    if (!constraintId || seen.has(constraintId)) continue;
    seen.add(constraintId);
    normalized.push({
      constraintId,
      source: ref.source,
      summary: ref.summary.trim(),
      evidenceRefs: normalizeEvidenceRefs(ref.evidenceRefs),
    });
  }
  return normalized;
}
