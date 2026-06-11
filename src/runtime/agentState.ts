/**
 * agentState.ts — 问路唯一状态容器。
 *
 * 设计原则：
 * 1. 唯一逻辑真相源——所有子系统读取同一份 AgentState
 * 2. 不可直接写入——写入必须经 reducer.ts 的 Command 通道
 * 3. 物理载体分层：snapshot(.json) + ledger(.ndjson) + artifacts(目录)
 * 4. 乐观锁防并发冲突（version 字段）
 */

// ═══════════════════════════════════════════════════════════════════════
// 子领域类型（从 riverMain 和 orchestrator 收编的所有散落状态）
// ═══════════════════════════════════════════════════════════════════════

export interface GoalDimension {
  id: string;
  name: string;
  current: number;
  target: number;
  lastEvidence: string;
  updatedAt: string;
}

export interface NorthStarGoal {
  mission: string;
  dimensions: GoalDimension[];
  updatedAt: string;
}

export interface Belief {
  id: string;
  dimension: "direction" | "value" | "pattern" | "state" | "identity";
  content: string;
  confidence: number;
  source: "observed" | "user-said" | "inferred" | "corrected";
  evidence: string;
  createdAt: string;
  correctedBy?: string;
  correctedAt?: string;
}

export interface KnowledgeEntry {
  id: string;
  content: string;
  source: "web-verified" | "file-observed" | "user-told" | "inferred-unverified";
  learnedAt: string;
}

export interface UserInsight {
  id: string;
  aspect: "boundary" | "value" | "communication-style" | "emotional-need" | "identity" | "goal";
  content: string;
  confidence: number;
  evidence: string;
  formedAt: string;
  supersededBy?: string;
}

export interface Prediction {
  id: string;
  claim: string;
  confidence: number;
  checkMethod: string;
  kind?: "grounded" | "hypothesis" | "self-competence";
  verdictCmd?: string;
  selfTaskId?: string;
  relatedTo?: string;
  madeAt: string;
  status: "open" | "hit" | "miss" | "expired" | "cancelled";
  settledAt?: string;
  settledEvidence?: string;
}

export interface VerifiableTask {
  id: string;
  description: string;
  verifyCmd: string;
  status: "open" | "passed" | "failed";
  declaredAt: string;
  verifiedAt?: string;
  evidence?: string;
}

export interface MasteredTool {
  name: string;
  description: string;
  script: string;
  createdAt: string;
  usageCount: number;
  lastUsed?: string;
}

export interface ReflectionEntry {
  cycle: number;
  timestamp: string;
  directive: string;
  dimensionAdjustments: Array<{ id: string; delta: number; reason: string }>;
  metaVerdict?: "accept" | "suspicious" | "reject";
  metaReason?: string;
}

export interface SelfHookModule {
  filename: string;
  lastModified: string;
  extraDirective?: string;
  preferredIntervalMs?: number;
}

export interface CapabilityMapCell {
  domain: string;
  difficulty: number;
  solution?: { description: string; score: number; achievedAt: string };
}

export interface VelocitySnapshot {
  capabilitySlope: number;
  judgmentSlope: number;
  coverageSlope: number;
  depthSlope: number;
  measuredAt: string;
}

export interface SensorState {
  name: string;
  script: string;
  createdAt: string;
  lastRun?: string;
  lastOutput?: string;
  dormant: boolean;
  consecutiveEmpty: number;
}

// ─── 用户镜像子域 ───

export interface UserShadowPrediction {
  id: string;
  context: string;
  predicted: string;
  actual?: string;
  hit?: boolean;
  madeAt: string;
  settledAt?: string;
}

export interface DriftSignal {
  insightId: string;
  conflictingEvidence: string;
  detectedAt: string;
  resolved: boolean;
  resolution?: string;
}

export interface GoalTension {
  shortTermWant: string;
  longTermGoal: string;
  tensionType: "desire-vs-goal" | "verbal-vs-behavioral" | "emotion-vs-value";
  detectedAt: string;
  resolution?: string;
}

// ─── 执行子域 ───

export interface ActiveTask {
  id: string;
  description: string;
  priority: "critical" | "high" | "normal" | "low" | "background";
  status: "pending" | "running" | "blocked" | "completed" | "failed";
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  blockReason?: string;
}

export interface RollbackCheckpoint {
  id: string;
  timestamp: string;
  description: string;
  stateVersion: number;
  artifacts: string[];
}

// ─── 预算子域 ───

export interface BudgetState {
  remoteLlm: { usedTokens: number; limitPerHour: number; windowStart: string };
  localInference: { usedCalls: number; limitPerHour: number; windowStart: string };
  network: { usedCalls: number; limitPerHour: number; windowStart: string };
  destructiveActions: { usedToday: number; limitPerDay: number; dayStart: string };
  exploration: { usedCalls: number; limitPerHour: number; windowStart: string };
}

// ═══════════════════════════════════════════════════════════════════════
// AgentState：统一状态容器
// ═══════════════════════════════════════════════════════════════════════

export interface AgentState {
  // === 身份 ===
  identity: {
    name: string;
    mission: string;
    cycles: number;
    lastHeartbeat: string;
    alive: boolean;
  };

  // === 执行 ===
  execution: {
    activeTasks: ActiveTask[];
    pendingVerifications: VerifiableTask[];
    rollbackPoints: RollbackCheckpoint[];
  };

  // === 记忆（从 hippocampus + beliefs + knowledge + riverbed + chronotopic 收编）===
  memory: {
    beliefs: Belief[];
    knowledge: KnowledgeEntry[];
    // riverbed 内联缓存（热数据），文件 ref 仅做持久化锚点
    riverbed: Record<string, Record<string, unknown>>;
    // 外部文件引用（冷存储）
    riverbedRef: string;      // 指向 artifacts/riverbed.json
    chronotopicRef: string;   // 指向 artifacts/chronotopic.json
    hippocampusRef: string;   // 指向 artifacts/hippocampus.json
  };

  // === 用户镜像 ===
  userMirror: {
    insights: UserInsight[];
    shadowPredictions: UserShadowPrediction[];
    driftSignals: DriftSignal[];
    goalTensions: GoalTension[];
    mirrorAccuracy: number;   // 0-1，shadow prediction 命中率
    actionAcceptRate: number; // agent 行动被用户接受的比率
  };

  // === 进化 ===
  evolution: {
    goal: NorthStarGoal;
    predictions: Prediction[];
    reflections: ReflectionEntry[];
    verifiableTasks: VerifiableTask[];
    capabilities: MasteredTool[];
    capabilityMap: CapabilityMapCell[];
    selfHooks: SelfHookModule[];
    sensors: SensorState[];
    velocity: VelocitySnapshot;
  };

  // === 预算治理 ===
  budget: BudgetState;

  // === 元数据 ===
  version: number;
  lastPersistedAt: string;
  createdAt: string;
}

// ═══════════════════════════════════════════════════════════════════════
// 工厂函数
// ═══════════════════════════════════════════════════════════════════════

export function createInitialAgentState(): AgentState {
  const now = new Date().toISOString();
  return {
    identity: {
      name: "问路",
      mission: "成为未来的我操作系统：理解我、预测我、替我执行、带我进化",
      cycles: 0,
      lastHeartbeat: now,
      alive: true,
    },
    execution: {
      activeTasks: [],
      pendingVerifications: [],
      rollbackPoints: [],
    },
    memory: {
      beliefs: [],
      knowledge: [],
      riverbed: {},
      riverbedRef: "artifacts/riverbed.json",
      chronotopicRef: "artifacts/chronotopic.json",
      hippocampusRef: "artifacts/hippocampus.json",
    },
    userMirror: {
      insights: [],
      shadowPredictions: [],
      driftSignals: [],
      goalTensions: [],
      mirrorAccuracy: 0,
      actionAcceptRate: 0,
    },
    evolution: {
      goal: {
        mission: "帮助未来的我持续升级",
        dimensions: [
          { id: "g_understand", name: "理解深度", current: 5, target: 90, lastEvidence: "初始化", updatedAt: now },
          { id: "g_capability", name: "能力广度", current: 5, target: 90, lastEvidence: "初始化", updatedAt: now },
          { id: "g_results", name: "实际成果", current: 0, target: 90, lastEvidence: "初始化", updatedAt: now },
          { id: "g_judgment", name: "判断力", current: 10, target: 90, lastEvidence: "初始化", updatedAt: now },
        ],
        updatedAt: now,
      },
      predictions: [],
      reflections: [],
      verifiableTasks: [],
      capabilities: [],
      capabilityMap: [],
      selfHooks: [],
      sensors: [],
      velocity: { capabilitySlope: 0, judgmentSlope: 0, coverageSlope: 0, depthSlope: 0, measuredAt: now },
    },
    budget: {
      remoteLlm: { usedTokens: 0, limitPerHour: 500000, windowStart: now },
      localInference: { usedCalls: 0, limitPerHour: 200, windowStart: now },
      network: { usedCalls: 0, limitPerHour: 100, windowStart: now },
      destructiveActions: { usedToday: 0, limitPerDay: 20, dayStart: now },
      exploration: { usedCalls: 0, limitPerHour: 30, windowStart: now },
    },
    version: 0,
    lastPersistedAt: now,
    createdAt: now,
  };
}
