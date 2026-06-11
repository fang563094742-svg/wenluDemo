/**
 * metaReflection.ts — 元反思验证层。
 *
 * 对 reflect() 产出的纠偏指令做确定性验证，防止 LLM 幻觉带偏进化方向。
 *
 * 验证规则（全部纯确定性，不调 LLM）：
 * 1. 实体引用校验：指令中提到的维度/工具/领域/目标是否在 agentState 中真实存在
 * 2. 历史对照：类似指令上次执行后 goalGap 变化了吗（正效/负效/无效）
 * 3. 矛盾检测：和最近 N 轮指令是否自相矛盾
 * 4. 可执行性：指令是否包含至少一个可映射到已知工具/行为的动作
 *
 * 只有 verdict === 'accept' 的反思才喂回 breathe。
 * suspicious 的记录但不执行。
 * reject 的直接丢弃。
 */

import type { AgentState } from "../runtime/agentState.js";

// ═══════════════════════════════════════════════════════════════════════
// 输入类型：来自 reflect() 的纠偏指令
// ═══════════════════════════════════════════════════════════════════════

export interface ReflectionDirective {
  id: string;
  cycle: number;
  timestamp: string;
  content: string;
  targetDimensions?: string[];
  targetTools?: string[];
  suggestedAction?: string;
}

// ═══════════════════════════════════════════════════════════════════════
// 输出类型
// ═══════════════════════════════════════════════════════════════════════

export type ReflectionVerdict = "accept" | "suspicious" | "reject";

export interface ReflectionValidation {
  directive: ReflectionDirective;
  checks: {
    referencesValid: boolean;
    invalidReferences: string[];
    historicalEfficacy: number;    // -1 到 1
    efficacySampleSize: number;
    contradictionScore: number;    // 0 到 1
    contradictionDetails: string[];
    actionability: boolean;
    actionableVerbs: string[];
  };
  verdict: ReflectionVerdict;
  reason: string;
  confidence: number;  // 0-1
}

// ═══════════════════════════════════════════════════════════════════════
// 验证逻辑
// ═══════════════════════════════════════════════════════════════════════

const ACTIONABLE_VERBS = [
  "use", "try", "explore", "avoid", "stop", "focus", "switch",
  "increase", "decrease", "add", "remove", "create", "delete",
  "execute", "run", "verify", "test", "read", "write", "search",
  "combine", "forge", "learn", "practice", "improve", "fix",
  "调整", "尝试", "使用", "避免", "停止", "聚焦", "切换",
  "增加", "减少", "创建", "删除", "执行", "验证", "搜索",
  "组合", "锻造", "学习", "练习", "改进", "修复",
];

const NEGATION_MARKERS = [
  "don't", "do not", "never", "stop", "avoid", "instead",
  "不要", "不再", "停止", "避免", "相反", "转而",
];

export function validateReflection(
  directive: ReflectionDirective,
  state: AgentState,
  recentDirectives: ReflectionDirective[],
): ReflectionValidation {
  const checks = {
    referencesValid: true,
    invalidReferences: [] as string[],
    historicalEfficacy: 0,
    efficacySampleSize: 0,
    contradictionScore: 0,
    contradictionDetails: [] as string[],
    actionability: false,
    actionableVerbs: [] as string[],
  };

  // === Check 1: 实体引用校验 ===
  checkReferences(directive, state, checks);

  // === Check 2: 历史对照 ===
  checkHistoricalEfficacy(directive, state, recentDirectives, checks);

  // === Check 3: 矛盾检测 ===
  checkContradictions(directive, recentDirectives, checks);

  // === Check 4: 可执行性 ===
  checkActionability(directive, state, checks);

  // === 综合判定 ===
  return computeVerdict(directive, checks);
}

// ═══════════════════════════════════════════════════════════════════════
// 内部检查函数
// ═══════════════════════════════════════════════════════════════════════

function checkReferences(
  directive: ReflectionDirective,
  state: AgentState,
  checks: ReflectionValidation["checks"],
): void {
  const content = directive.content.toLowerCase();

  // 检查提到的工具名是否存在
  if (directive.targetTools) {
    const knownTools = new Set([
      ...state.evolution.capabilities.map(c => c.name),
      // 内置工具名
      "read_file", "write_file", "list_directory", "execute_command",
      "web_search", "browse_url", "say_to_user", "ask_user",
      "add_knowledge", "add_belief", "reflect_on_beliefs",
      "add_riverbed_judgement",
      "declare_verifiable_task", "verify_task", "forge_capability",
      "master_tool", "use_mastered_tool", "grow_sensor",
      "evolve_self_code", "understand_user",
    ]);

    for (const tool of directive.targetTools) {
      if (!knownTools.has(tool)) {
        checks.invalidReferences.push(`tool:${tool}`);
      }
    }
  }

  // 检查提到的维度是否存在
  if (directive.targetDimensions) {
    const knownDimensions = [
      "coding", "system", "web", "data", "creative",
      "communication", "analysis", "tool_use", "self_improvement",
    ];
    for (const dim of directive.targetDimensions) {
      if (!knownDimensions.includes(dim.toLowerCase())) {
        checks.invalidReferences.push(`dimension:${dim}`);
      }
    }
  }

  // 检查提到的领域
  const domainPattern = /(?:领域|domain|area)\s*[:：]?\s*["']?(\w+)/gi;
  let match: RegExpExecArray | null;
  while ((match = domainPattern.exec(content)) !== null) {
    const domain = match[1];
    const knownDomains = [
      "coding", "system", "web", "data", "creative", "net",
      "fs", "db", "ai", "math", "security", "devops",
    ];
    if (!knownDomains.includes(domain.toLowerCase())) {
      checks.invalidReferences.push(`domain:${domain}`);
    }
  }

  checks.referencesValid = checks.invalidReferences.length === 0;
}

function checkHistoricalEfficacy(
  directive: ReflectionDirective,
  state: AgentState,
  recentDirectives: ReflectionDirective[],
  checks: ReflectionValidation["checks"],
): void {
  if (recentDirectives.length === 0) {
    checks.historicalEfficacy = 0; // 无历史数据，中性
    checks.efficacySampleSize = 0;
    return;
  }

  // 找与当前指令相似的历史指令（Jaccard 相似度）
  const currentTokens = new Set(tokenize(directive.content));
  const similarDirectives: ReflectionDirective[] = [];

  for (const d of recentDirectives) {
    const otherTokens = new Set(tokenize(d.content));
    const intersection = new Set([...currentTokens].filter(t => otherTokens.has(t)));
    const union = new Set([...currentTokens, ...otherTokens]);
    const similarity = union.size > 0 ? intersection.size / union.size : 0;
    if (similarity > 0.4) {
      similarDirectives.push(d);
    }
  }

  if (similarDirectives.length === 0) {
    checks.historicalEfficacy = 0;
    checks.efficacySampleSize = 0;
    return;
  }

  // 看类似指令执行后的效果（简化：看后续 goalGap 是否缩小）
  // 这里用 reflections 中的 goalGap 变化来近似
  const reflections = state.evolution.reflections;
  let positiveCount = 0;
  let negativeCount = 0;

  for (const sd of similarDirectives) {
    const afterReflections = reflections.filter(r => r.cycle > sd.cycle && r.cycle <= sd.cycle + 5);
    for (const ar of afterReflections) {
      // 用 dimensionAdjustments 中 delta < 0 作为正效果信号（差距缩小）
      const hasPositive = ar.dimensionAdjustments?.some(adj => adj.delta < 0);
      if (hasPositive) positiveCount++;
      else negativeCount++;
    }
  }

  const total = positiveCount + negativeCount;
  checks.efficacySampleSize = total;
  if (total === 0) {
    checks.historicalEfficacy = 0;
  } else {
    checks.historicalEfficacy = (positiveCount - negativeCount) / total; // -1 to 1
  }
}

function checkContradictions(
  directive: ReflectionDirective,
  recentDirectives: ReflectionDirective[],
  checks: ReflectionValidation["checks"],
): void {
  if (recentDirectives.length === 0) {
    checks.contradictionScore = 0;
    return;
  }

  const last3 = recentDirectives.slice(-3);
  let contradictions = 0;
  let totalChecks = 0;

  const currentTokens = tokenize(directive.content);
  const currentHasNegation = NEGATION_MARKERS.some(n => directive.content.toLowerCase().includes(n));

  for (const prev of last3) {
    totalChecks++;
    const prevTokens = tokenize(prev.content);

    // 共享大量词汇但方向相反（一个有否定词一个没有）
    const prevHasNegation = NEGATION_MARKERS.some(n => prev.content.toLowerCase().includes(n));
    const sharedTokens = currentTokens.filter(t => prevTokens.includes(t));
    const overlap = sharedTokens.length / Math.max(currentTokens.length, 1);

    if (overlap > 0.5 && currentHasNegation !== prevHasNegation) {
      contradictions++;
      checks.contradictionDetails.push(
        `conflicts with cycle ${prev.cycle}: "${prev.content.slice(0, 50)}..." (negation flip)`
      );
    }

    // 直接相反的动作目标
    if (directive.targetDimensions && prev.targetDimensions) {
      const sameDims = directive.targetDimensions.filter(d => prev.targetDimensions!.includes(d));
      if (sameDims.length > 0 && directive.suggestedAction !== prev.suggestedAction) {
        if (currentHasNegation !== prevHasNegation) {
          contradictions++;
          checks.contradictionDetails.push(
            `same dimensions [${sameDims.join(",")}] but opposite actions vs cycle ${prev.cycle}`
          );
        }
      }
    }
  }

  checks.contradictionScore = totalChecks > 0 ? contradictions / totalChecks : 0;
}

function checkActionability(
  directive: ReflectionDirective,
  state: AgentState,
  checks: ReflectionValidation["checks"],
): void {
  const content = directive.content.toLowerCase();
  const foundVerbs = ACTIONABLE_VERBS.filter(v => content.includes(v.toLowerCase()));
  checks.actionableVerbs = foundVerbs;
  checks.actionability = foundVerbs.length > 0;
}

// ═══════════════════════════════════════════════════════════════════════
// 综合判定
// ═══════════════════════════════════════════════════════════════════════

function computeVerdict(
  directive: ReflectionDirective,
  checks: ReflectionValidation["checks"],
): ReflectionValidation {
  let score = 100; // 从满分开始扣
  const reasons: string[] = [];

  // 引用无效 → 扣分
  if (!checks.referencesValid) {
    score -= 30 * Math.min(checks.invalidReferences.length, 3);
    reasons.push(`invalid references: ${checks.invalidReferences.join(", ")}`);
  }

  // 历史负效果 → 扣分
  if (checks.historicalEfficacy < -0.3 && checks.efficacySampleSize >= 2) {
    score -= 40;
    reasons.push(`historically ineffective (efficacy=${checks.historicalEfficacy.toFixed(2)}, n=${checks.efficacySampleSize})`);
  }

  // 矛盾度高 → 扣分
  if (checks.contradictionScore > 0.5) {
    score -= 35;
    reasons.push(`contradicts recent directives (score=${checks.contradictionScore.toFixed(2)})`);
  }

  // 不可执行 → 扣分
  if (!checks.actionability) {
    score -= 25;
    reasons.push("no actionable verbs found");
  }

  // 判定
  let verdict: ReflectionVerdict;
  if (score >= 70) {
    verdict = "accept";
  } else if (score >= 40) {
    verdict = "suspicious";
  } else {
    verdict = "reject";
  }

  return {
    directive,
    checks,
    verdict,
    reason: reasons.length > 0 ? reasons.join("; ") : "all checks passed",
    confidence: Math.max(0, Math.min(1, score / 100)),
  };
}

// ═══════════════════════════════════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════════════════════════════════

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w一-鿿\s]/g, " ")
    .split(/\s+/)
    .filter(t => t.length > 2);
}
