/**
 * contextAssembler.ts — 统一上下文编译器。
 *
 * 核心职责：确保 decide / reflect / reply / evolve 四种 LLM 调用
 * 都从同一套 agentState 中裁切上下文，而不是各自拼凑不同叙事。
 *
 * 设计原则：
 * 1. 单一数据源：所有上下文都从 agentState + actionLedger 编译
 * 2. 视角裁切：不同用途看到不同投影，但底层真相唯一
 * 3. token 预算感知：按预算控制上下文长度，优先保留最新/最相关内容
 * 4. 不隐藏也不虚构：投影只做过滤和裁切，不修改事实
 */

import type { AgentState } from "../runtime/agentState.js";
import type { LedgerEntry, ActionLedger } from "../runtime/actionLedger.js";

// ═══════════════════════════════════════════════════════════════════════
// 上下文用途
// ═══════════════════════════════════════════════════════════════════════

export type ContextPurpose =
  | "decide"     // 选工具/填参数
  | "reflect"    // 元反思
  | "reply"      // 回复用户
  | "evolve"     // 自我进化决策
  | "verify"     // 验证任务
  | "explore"    // 探索性实验
  ;

// ═══════════════════════════════════════════════════════════════════════
// 编译产出：结构化上下文
// ═══════════════════════════════════════════════════════════════════════

export interface CompiledContext {
  purpose: ContextPurpose;
  timestamp: string;
  tokenBudget: number;
  estimatedTokens: number;

  // 按优先级排列的上下文块
  sections: ContextSection[];

  // 最终拼接成的 prompt 字符串
  prompt: string;
}

export interface ContextSection {
  id: string;
  label: string;
  priority: number;  // 0-100，越高越先保留
  content: string;
  estimatedTokens: number;
  truncated: boolean;
}

// ═══════════════════════════════════════════════════════════════════════
// 编译器配置
// ═══════════════════════════════════════════════════════════════════════

export interface ContextAssemblerConfig {
  defaultTokenBudget: number;
  budgetByPurpose?: Partial<Record<ContextPurpose, number>>;
  includeSystemIdentity: boolean;
  includeUserMirror: boolean;
  includeEvolutionState: boolean;
  maxRecentLedgerEntries: number;
  maxRecentBeliefs: number;
  maxRecentKnowledge: number;
}

const DEFAULT_CONFIG: ContextAssemblerConfig = {
  defaultTokenBudget: 4000,
  budgetByPurpose: {
    decide: 3000,
    reflect: 5000,
    reply: 4000,
    evolve: 6000,
    verify: 2000,
    explore: 4000,
  },
  includeSystemIdentity: true,
  includeUserMirror: true,
  includeEvolutionState: true,
  maxRecentLedgerEntries: 10,
  maxRecentBeliefs: 15,
  maxRecentKnowledge: 10,
};

// ═══════════════════════════════════════════════════════════════════════
// 编译器
// ═══════════════════════════════════════════════════════════════════════

export interface ContextAssembler {
  compile(purpose: ContextPurpose, state: AgentState, ledger: ActionLedger, extra?: Record<string, string>): CompiledContext;
  estimateTokens(text: string): number;
}

export function createContextAssembler(config: Partial<ContextAssemblerConfig> = {}): ContextAssembler {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  function estimateTokens(text: string): number {
    // 粗略估算：中文约 1.5 token/字，英文约 0.75 token/word
    const cjkChars = (text.match(/[一-鿿㐀-䶿]/g) || []).length;
    const words = text.replace(/[一-鿿㐀-䶿]/g, "").split(/\s+/).filter(Boolean).length;
    return Math.ceil(cjkChars * 1.5 + words * 1.3);
  }

  function buildSections(purpose: ContextPurpose, state: AgentState, ledger: ActionLedger, extra?: Record<string, string>): ContextSection[] {
    const sections: ContextSection[] = [];

    // === 系统身份（所有用途都需要，但 decide 可以精简）===
    if (cfg.includeSystemIdentity) {
      const identityContent = buildIdentitySection(state, purpose);
      sections.push({
        id: "identity",
        label: "System Identity",
        priority: purpose === "decide" ? 60 : 80,
        content: identityContent,
        estimatedTokens: estimateTokens(identityContent),
        truncated: false,
      });
    }

    // === 当前任务 / 执行状态（decide 和 verify 最需要）===
    if (purpose === "decide" || purpose === "verify" || purpose === "explore") {
      const execContent = buildExecutionSection(state, ledger);
      sections.push({
        id: "execution",
        label: "Current Execution State",
        priority: 95,
        content: execContent,
        estimatedTokens: estimateTokens(execContent),
        truncated: false,
      });
    }

    // === 最近行动记录 ===
    const recentActions = buildRecentActionsSection(ledger);
    sections.push({
      id: "recent-actions",
      label: "Recent Actions",
      priority: purpose === "reflect" ? 90 : 70,
      content: recentActions,
      estimatedTokens: estimateTokens(recentActions),
      truncated: false,
    });

    // === 用户镜像（reply 最需要）===
    if (cfg.includeUserMirror && (purpose === "reply" || purpose === "decide")) {
      const mirrorContent = buildUserMirrorSection(state);
      sections.push({
        id: "user-mirror",
        label: "User Understanding",
        priority: purpose === "reply" ? 85 : 50,
        content: mirrorContent,
        estimatedTokens: estimateTokens(mirrorContent),
        truncated: false,
      });
    }

    // === 进化状态（evolve 和 reflect 最需要）===
    if (cfg.includeEvolutionState && (purpose === "evolve" || purpose === "reflect")) {
      const evolContent = buildEvolutionSection(state);
      sections.push({
        id: "evolution",
        label: "Evolution State",
        priority: purpose === "evolve" ? 90 : 75,
        content: evolContent,
        estimatedTokens: estimateTokens(evolContent),
        truncated: false,
      });
    }

    // === 信念和知识（reflect 最需要）===
    if (purpose === "reflect" || purpose === "evolve") {
      const beliefsContent = buildBeliefsSection(state);
      sections.push({
        id: "beliefs",
        label: "Active Beliefs",
        priority: 65,
        content: beliefsContent,
        estimatedTokens: estimateTokens(beliefsContent),
        truncated: false,
      });
    }

    // === 额外上下文（调用方注入）===
    if (extra) {
      for (const [key, value] of Object.entries(extra)) {
        sections.push({
          id: `extra-${key}`,
          label: key,
          priority: 85,
          content: value,
          estimatedTokens: estimateTokens(value),
          truncated: false,
        });
      }
    }

    return sections;
  }

  function compile(purpose: ContextPurpose, state: AgentState, ledger: ActionLedger, extra?: Record<string, string>): CompiledContext {
    const tokenBudget = cfg.budgetByPurpose?.[purpose] ?? cfg.defaultTokenBudget;
    let sections = buildSections(purpose, state, ledger, extra);

    // 按优先级排序
    sections.sort((a, b) => b.priority - a.priority);

    // 裁切：保留高优先级的直到 token 预算用完
    let usedTokens = 0;
    const included: ContextSection[] = [];

    for (const section of sections) {
      if (usedTokens + section.estimatedTokens <= tokenBudget) {
        included.push(section);
        usedTokens += section.estimatedTokens;
      } else {
        // 尝试截断
        const remaining = tokenBudget - usedTokens;
        if (remaining > 100) {
          const truncatedContent = truncateToTokens(section.content, remaining);
          included.push({ ...section, content: truncatedContent, truncated: true, estimatedTokens: remaining });
          usedTokens += remaining;
        }
        break;
      }
    }

    // 拼接成最终 prompt
    const prompt = included.map(s => `[${s.label}]\n${s.content}`).join("\n\n---\n\n");

    return {
      purpose,
      timestamp: new Date().toISOString(),
      tokenBudget,
      estimatedTokens: usedTokens,
      sections: included,
      prompt,
    };
  }

  return { compile, estimateTokens };
}

// ═══════════════════════════════════════════════════════════════════════
// Section 构建器
// ═══════════════════════════════════════════════════════════════════════

function buildIdentitySection(state: AgentState, purpose: ContextPurpose): string {
  const { identity } = state;
  if (purpose === "decide") {
    return `Mission: ${identity.mission}\nCycle: ${identity.cycles}`;
  }
  return [
    `Mission: ${identity.mission}`,
    `Cycles: ${identity.cycles}`,
    `Last heartbeat: ${new Date(identity.lastHeartbeat).toISOString()}`,
  ].join("\n");
}

function buildExecutionSection(state: AgentState, ledger: ActionLedger): string {
  const { execution } = state;
  const lines: string[] = [];

  if (execution.activeTasks.length > 0) {
    lines.push("Active tasks:");
    for (const task of execution.activeTasks.slice(0, 5)) {
      lines.push(`  - [${task.status}] ${task.description?.slice(0, 80)}`);
    }
  }

  if (execution.pendingVerifications.length > 0) {
    lines.push(`Pending verifications: ${execution.pendingVerifications.length}`);
  }

  return lines.join("\n") || "No active tasks.";
}

function buildRecentActionsSection(_ledger: ActionLedger): string {
  // ActionLedger.tail() is async; context assembly is sync. Return placeholder.
  return "(recent actions loaded async)";
}

function buildUserMirrorSection(state: AgentState): string {
  const { userMirror } = state;
  if (userMirror.insights.length === 0) return "No user insights yet.";

  const topInsights = userMirror.insights.slice(0, 5);
  return topInsights.map(i => `- [${i.aspect}] ${i.content?.slice(0, 100)}`).join("\n");
}

function buildEvolutionSection(state: AgentState): string {
  const { evolution } = state;
  const lines: string[] = [];

  lines.push(`Goal: ${evolution.goal.mission ?? "undefined"}`);
  lines.push(`Capabilities: ${evolution.capabilities.length}`);
  lines.push(`Verified tasks: ${evolution.verifiableTasks.length}`);

  if (evolution.velocity) {
    const v = evolution.velocity;
    lines.push(`Velocity: capability_slope=${v.capabilitySlope?.toFixed(2)}, judgment_slope=${v.judgmentSlope?.toFixed(2)}`);
  }

  return lines.join("\n");
}

function buildBeliefsSection(state: AgentState): string {
  const beliefs = state.memory.beliefs.slice(0, 15);
  if (beliefs.length === 0) return "No active beliefs.";

  return beliefs.map(b =>
    `- [${b.confidence?.toFixed(2) ?? "?"}] ${b.content?.slice(0, 100)}`
  ).join("\n");
}

// ═══════════════════════════════════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════════════════════════════════

function truncateToTokens(text: string, targetTokens: number): string {
  // 粗略：1 token ≈ 4 chars for English, 2 chars for CJK
  const approxChars = targetTokens * 3;
  if (text.length <= approxChars) return text;
  return text.slice(0, approxChars) + "\n...[truncated]";
}
