/**
 * 主权自体 · Component 2：统一真相源 / 双写 / 一致性比对（unify.ts）
 * ------------------------------------------------------------------
 * 渐进收编：把 riverMain 的既有写入翻译成 runtime CQRS Command（影子双写），
 * 并提供 mind.json 投影 vs store 投影 的字段级比对，验证 store 是真大脑的忠实镜像。
 * 库内不直接持有 store（避免反向耦合），只产出 Command 列表与比对报告，由接线点 dispatch。
 * _Requirements: 1.1, 1.2, 1.4, 1.5_
 */

/** riverMain 的一次既有写入（领域无关描述）。 */
export interface MindChange {
  kind: string; // 如 "belief/add" | "userModel/add" | "goal/update" | "prediction/add"
  payload: unknown;
}

/** 翻译成 runtime Command 形态（kind+payload）。映射未知则返回空（不强行造命令）。 */
export interface DualWriteCommand {
  kind: string;
  payload: unknown;
}

/** 把 riverMain 写入映射为 runtime store 双写命令。未识别的 kind 返回空数组（fail-safe）。 */
export function toDualWriteCommands(change: MindChange): DualWriteCommand[] {
  if (!change || typeof change.kind !== "string") return [];
  // 直通映射：riverMain 已用与 reducer 同构的 kind 命名时直接转发。
  const known = new Set([
    "belief/add", "belief/update", "belief/remove",
    "knowledge/add", "knowledge/remove",
    "mirror/insight-add", "mirror/insight-update", "mirror/prediction-add", "mirror/prediction-settle", "mirror/drift-signal",
    "evolution/goal-update", "evolution/capability-add", "evolution/reflection-add", "evolution/task-add", "evolution/task-update",
    "task/add", "task/update", "task/remove",
    "identity/heartbeat", "identity/cycle-increment",
  ]);
  if (known.has(change.kind)) return [{ kind: change.kind, payload: change.payload }];
  return [];
}

export interface ConsistencyReport {
  fieldsCompared: number;
  diffs: Array<{ field: string; mind: unknown; store: unknown }>;
  faithful: boolean;
}

function stableStr(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableStr).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableStr(o[k])}`).join(",")}}`;
}

/**
 * 字段级一致性比对：对 keyFields 逐个比 mind 投影 vs store 投影。
 * 关键字段全一致 ⟹ faithful=true；否则列出 diff。纯函数。
 */
export function compareMindVsStore(
  mindProjection: Record<string, unknown>,
  storeProjection: Record<string, unknown>,
  keyFields: ReadonlyArray<string>,
): ConsistencyReport {
  const diffs: Array<{ field: string; mind: unknown; store: unknown }> = [];
  for (const f of keyFields) {
    const m = mindProjection?.[f];
    const s = storeProjection?.[f];
    if (stableStr(m) !== stableStr(s)) diffs.push({ field: f, mind: m, store: s });
  }
  return { fieldsCompared: keyFields.length, diffs, faithful: diffs.length === 0 };
}
