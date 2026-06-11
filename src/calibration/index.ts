/**
 * 用户活画像（Calibration Profile）· 移植自产品后端 lib/wenlu/calibration
 * ------------------------------------------------------------------
 * 剥壳：去掉 server-only / sqlite / askWenluModel 直依赖。LLM 推断改由调用方
 * （riverMain 的 llm）注入；profile 存 mind.calibrationProfile（mind.json）。
 *
 * 第一性价值：弟弟原有 userModel 是零散 insight 列表；这里补上产品后端的
 * 8 维【结构化活画像】，每次互动增量合并，并注入意识 system prompt 头部——
 * 这是"真正懂他"的结构化底座（区别于 judgment/calibration 的判断力打分尺）。
 *
 * 全局联动（非孤岛）：
 *   - 输入：每次互动落 observation（用户消息 / 任务完成 / 反思结论）。
 *   - 推断：reflect 节律里用既有 llm 推 8 维 delta，纯函数 merge 写回。
 *   - 输出：profileAsSystemBlock 注入 buildConsciousness（所有呼吸都读到）。
 *
 * merge / render / drift 均为确定性纯函数；推断由调用方注入 llm。
 */

export const PROFILE_FIELDS = [
  "currentFocus",
  "executionStyle",
  "valuesPrinciples",
  "petPeeves",
  "preferredTone",
  "capabilityState",
  "emotionalBaseline",
  "openQuestions",
] as const;
export type ProfileField = (typeof PROFILE_FIELDS)[number];

/** 8 维中文标签（渲染 + 推断 prompt 共用）。 */
export const FIELD_LABELS: Record<ProfileField, string> = {
  currentFocus: "当前最在意的",
  executionStyle: "他喜欢的执行方式",
  valuesPrinciples: "他的价值观与原则",
  petPeeves: "雷点 / 特别讨厌的",
  preferredTone: "对话语气偏好",
  capabilityState: "他当前的能力 / 资源 / 约束",
  emotionalBaseline: "情绪基线",
  openQuestions: "我还没搞清楚的事（要主动问）",
};

/** 活画像（挂在 mind.calibrationProfile，存 mind.json）。 */
export interface CalibrationProfile {
  currentFocus: string | null;
  executionStyle: string | null;
  valuesPrinciples: string | null;
  petPeeves: string | null;
  preferredTone: string | null;
  capabilityState: string | null;
  emotionalBaseline: string | null;
  openQuestions: string | null;
  version: number;
  lastCalibratedAt: string | null;
  /** 用户锁定的字段（lock 的字段不被推断覆盖）。 */
  locks: Partial<Record<ProfileField, true>>;
}

export function emptyCalibrationProfile(): CalibrationProfile {
  return {
    currentFocus: null,
    executionStyle: null,
    valuesPrinciples: null,
    petPeeves: null,
    preferredTone: null,
    capabilityState: null,
    emotionalBaseline: null,
    openQuestions: null,
    version: 0,
    lastCalibratedAt: null,
    locks: {},
  };
}

/** 合并 delta（覆盖式；锁定字段跳过）。确定性纯函数，不修改入参。 */
export function applyDelta(
  profile: CalibrationProfile,
  delta: Partial<Record<ProfileField, string>>,
): CalibrationProfile {
  const next: CalibrationProfile = { ...profile, locks: { ...profile.locks } };
  for (const f of PROFILE_FIELDS) {
    if (profile.locks[f]) continue;
    const v = delta[f];
    if (typeof v === "string" && v.trim()) {
      (next as unknown as Record<string, string | null>)[f] = v.trim();
    }
  }
  return next;
}

/** 推断用的 system prompt（8 维 delta JSON）。供调用方喂给 llm。 */
export const CALIBRATION_INFER_SYSTEM = `你是问路的"校准官"。看一组最近真实观察，按 8 维更新你对用户的理解。
8 维：currentFocus(当前最在意) / executionStyle(执行方式) / valuesPrinciples(价值观原则) /
petPeeves(雷点) / preferredTone(语气偏好) / capabilityState(能力资源约束) /
emotionalBaseline(情绪基线) / openQuestions(你还没搞清、下次要主动问的)。
只输出 JSON：{"delta":{"字段":"新版本全文"},"reasoning":"为什么(<200字)"}。
规则：只更新真有新证据的字段，其他省略键；值是覆盖式全文(精炼保留已成立的事)；每字段≤3行；
没证据不写；openQuestions 写"还该问什么"；只输出 JSON，不要 code fence。`;

/** 解析 llm 返回的 delta（容错；只取 8 维里的字符串值）。 */
export function parseDelta(raw: string): { delta: Partial<Record<ProfileField, string>>; reasoning: string } {
  const stripped = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  let parsed: Record<string, unknown> | null = null;
  try {
    const v = JSON.parse(stripped);
    parsed = typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
  } catch {
    parsed = null;
  }
  if (!parsed) return { delta: {}, reasoning: "(无有效 JSON)" };
  const deltaRaw = parsed.delta && typeof parsed.delta === "object" ? (parsed.delta as Record<string, unknown>) : {};
  const delta: Partial<Record<ProfileField, string>> = {};
  for (const f of PROFILE_FIELDS) {
    const v = deltaRaw[f];
    if (typeof v === "string" && v.trim()) delta[f] = v.trim();
  }
  const reasoning = typeof parsed.reasoning === "string" ? parsed.reasoning : "";
  return { delta, reasoning };
}

/** 渲染当前画像快照（喂给推断 prompt 的 user 部分）。 */
export function profileSnapshot(profile: CalibrationProfile): string {
  return PROFILE_FIELDS.map((f) => {
    const v = (profile as unknown as Record<string, string | null>)[f];
    return `- ${f}: ${v ? v.replace(/\s+/g, " ").slice(0, 200) : "（空）"}`;
  }).join("\n");
}

/** 把画像写成 system prompt 块（注入意识；字段为空不写）。确定性纯函数。 */
export function profileAsSystemBlock(profile: CalibrationProfile): string {
  const sections: string[] = [];
  for (const f of PROFILE_FIELDS) {
    const v = (profile as unknown as Record<string, string | null>)[f];
    if (v && v.trim()) sections.push(`### ${FIELD_LABELS[f]}\n${v.trim()}`);
  }
  if (sections.length === 0) return "";
  return [
    "== 关于这位用户（持续校准的活画像，8维）==",
    "下面是你对他的当前理解，每次互动都会更新。回答 / 拟计划 / 引领时务必参考。",
    sections.join("\n\n"),
    `画像版本 v${profile.version}，最近校准 ${profile.lastCalibratedAt ?? "—"}。`,
  ].join("\n");
}

/** 漂移检测：空字段 ≥3 或 7 天未校准 → 该主动找用户澄清。确定性纯函数。 */
export function checkDrift(profile: CalibrationProfile, nowMs: number): {
  shouldClarify: boolean;
  emptyFields: ProfileField[];
} {
  const empty: ProfileField[] = [];
  for (const f of PROFILE_FIELDS) {
    const v = (profile as unknown as Record<string, string | null>)[f];
    if (!v || !v.trim()) empty.push(f);
  }
  let stale = false;
  if (profile.lastCalibratedAt) {
    stale = nowMs - new Date(profile.lastCalibratedAt).getTime() > 7 * 24 * 3600 * 1000;
  }
  return { shouldClarify: empty.length >= 3 || stale, emptyFields: empty };
}
