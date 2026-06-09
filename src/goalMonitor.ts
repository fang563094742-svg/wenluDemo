export interface GoalFocus {
  dimensionId: string;
  dimensionName: string;
  gap: number;
  evidence: string;
}

export interface GoalDeltaSignal {
  touchedDimensions: string[];
  evidence: string[];
  summary: string;
  strongestEvidenceType: "goal_update" | "prediction_settled" | "result_evidence" | "capability" | "understanding" | "none";
}

export interface GoalMonitorSnapshot {
  gap: number;
  largestGap: GoalFocus | null;
  hasShrinkSignal: boolean;
  deltaSignal: GoalDeltaSignal;
  recentActionSummary: string;
}

export interface GoalMonitorInput {
  goal: {
    dimensions: Array<{
      id: string;
      name: string;
      current: number;
      target: number;
      lastEvidence?: string;
    }>;
  } | undefined;
  recentActions: string[];
  lastGoalUpdateCycle?: number;
  currentCycle: number;
  noveltyCount: number;
}

function normalize(text: string): string {
  return (text || "").toLowerCase();
}

function includesAny(text: string, keywords: string[]): boolean {
  return keywords.some((k) => text.includes(k));
}

function detectTouchedDimensions(actions: string[]): string[] {
  const ids = new Set<string>();
  for (const raw of actions) {
    const text = normalize(raw);
    if (includesAny(text, ["predict", "settle_prediction", "命中率", "结算预测", "prediction", "预测", "hit", "miss"])) ids.add("g_judgment");
    if (includesAny(text, ["master_tool", "forge_capability", "新能力", "能力", "tool", "脚本", "复跑", "能力已沉淀"])) ids.add("g_capability");
    if (includesAny(text, ["understand_user", "用户理解", "边界", "价值观", "goal|", "identity|", "belief", "理解加深"])) ids.add("g_understand");
    if (includesAny(text, ["update_goal", "收款", "外发", "成交", "发送", "回款", "结果", "evidence", "留证", "公开外发", "到账", "入账"])) ids.add("g_results");
  }
  return [...ids];
}

function detectStrongestEvidenceType(actions: string[]): GoalDeltaSignal["strongestEvidenceType"] {
  const joined = normalize(actions.join(" | "));
  if (includesAny(joined, ["update_goal", "目标维度", "总差距现为"])) return "goal_update";
  if (includesAny(joined, ["settle_prediction", "结算预测", "命中率", "hit", "miss"])) return "prediction_settled";
  if (includesAny(joined, ["收款", "回款", "发送证据", "公开外发", "留证", "到账", "入账", "evidence"])) return "result_evidence";
  if (includesAny(joined, ["forge_capability", "master_tool", "复跑", "能力", "脚本"])) return "capability";
  if (includesAny(joined, ["understand_user", "add_belief", "用户理解", "边界", "价值观", "identity|", "goal|"])) return "understanding";
  return "none";
}

export function inspectGoalMonitor(input: GoalMonitorInput): GoalMonitorSnapshot {
  const dims = input.goal?.dimensions ?? [];
  const sorted = [...dims]
    .map((d) => ({
      dimensionId: d.id,
      dimensionName: d.name,
      gap: Math.max(0, d.target - d.current),
      evidence: d.lastEvidence ?? "",
    }))
    .sort((a, b) => b.gap - a.gap);

  const largestGap = sorted[0] ?? null;
  const recentActions = input.recentActions.slice(-8);
  const touchedDimensions = detectTouchedDimensions(recentActions);
  const strongestEvidenceType = detectStrongestEvidenceType(recentActions);
  const hasMeaningfulEvidence = strongestEvidenceType !== "none";
  const hasShrinkSignal = Boolean(
    largestGap
      && touchedDimensions.includes(largestGap.dimensionId)
      && input.noveltyCount > 0
      && (hasMeaningfulEvidence || input.lastGoalUpdateCycle === input.currentCycle),
  );

  return {
    gap: sorted.length ? Math.round(sorted.reduce((sum, d) => sum + d.gap, 0) / sorted.length) : 100,
    largestGap,
    hasShrinkSignal,
    deltaSignal: {
      touchedDimensions,
      evidence: recentActions,
      summary: hasShrinkSignal
        ? `最近动作已命中最大差距维度 ${largestGap?.dimensionId ?? "unknown"}，且留下 ${strongestEvidenceType} 级证据`
        : `最近动作未命中最大差距维度 ${largestGap?.dimensionId ?? "unknown"}，或没有留下可缩差证据`,
      strongestEvidenceType,
    },
    recentActionSummary: recentActions.join(" | "),
  };
}
