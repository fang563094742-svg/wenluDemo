/**
 * 海马体 + 前额叶 类型定义
 *
 * 分层记忆系统的核心类型，以及前额叶决策层所需的交互状态。
 */

// ─── 记忆条目基类 ─────────────────────────────────────────────

/** 所有记忆条目的基础字段 */
export interface ScoredEntry {
  id: string;
  importance: number;          // 0-1，写入时计算
  accessCount: number;         // 被检索次数
  lastAccessedCycle: number;   // 最近一次被检索的 cycle
  createdCycle: number;        // 创建时的 cycle
  createdAt: string;           // ISO 时间戳
}

// ─── 事件记忆 (Episodic) ──────────────────────────────────────

export type EpisodeSource =
  | "user-said"
  | "user-emotion"
  | "observed-action"
  | "inferred"
  | "runtime";

export interface Episode extends ScoredEntry {
  type: "episodic";
  content: string;
  source: EpisodeSource;
  context?: string;            // 形成时的背景
  dimension?: string;          // 归类维度（可选）
  consolidated?: boolean;      // 已被提炼为 concept
}

// ─── 语义记忆 (Semantic) ──────────────────────────────────────

export interface Concept extends ScoredEntry {
  type: "semantic";
  content: string;
  dimension?: string;          // 归类维度
  sourceEpisodeIds: string[];  // 提炼来源
}

// ─── 分层记忆结构 ─────────────────────────────────────────────

export interface WorkingMemory {
  currentContext: string[];    // 当前 cycle 浮现的相关记忆
  recentTopics: string[];      // 最近话题（从对话提取）
  activeGoals: string[];       // 当前运行中的任务目标
  attentionFocus?: string;     // 前额叶指定的焦点
}

export interface MemoryMeta {
  version: number;
  lastConsolidationCycle: number;
  totalEpisodesCreated: number;
  totalConceptsCreated: number;
  prunedCount: number;
}

export interface LayeredMemory {
  working: WorkingMemory;
  episodic: Episode[];
  semantic: Concept[];
  procedural: {
    tools: Array<{ name: string; command: string; description: string }>;
    rules: Array<{ rule: string; confidence: number; source: string }>;
  };
  meta: MemoryMeta;
}

// ─── 前额叶交互状态 ──────────────────────────────────────────

export interface PendingDelivery {
  taskId: string;
  completedAt: string;
  summary: string;
  delivered: boolean;
}

export interface InteractionState {
  lastSayTime: string | null;
  lastSayTopic: string | null;
  userRespondedToLastSay: boolean;
  pendingDeliveries: PendingDelivery[];
  lastUserMessageTime: string | null;
  consecutiveIdleBreaths: number;
  breathsSinceLastConsolidation: number;
  replanRequired: boolean;
}

// ─── 前额叶决策输出 ──────────────────────────────────────────

export type PrefrontalAction =
  | "breathe"
  | "force-report"
  | "reply-user"
  | "replan-after-user"
  | "consolidate"
  | "skip";

export interface PrefrontalDecision {
  action: PrefrontalAction;
  priority?: string;
  context?: string;
}

// ─── 巩固报告 ─────────────────────────────────────────────────

export interface ConsolidationReport {
  deduped: number;
  decayed: number;
  conceptsCreated: number;
  episodesArchived: number;
  pruned: number;
  forgotten: number;       // 被遗忘曲线淘汰的条目数
}
