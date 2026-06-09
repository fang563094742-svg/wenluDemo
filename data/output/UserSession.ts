/**
 * 问路 — 用户会话：每个活跃用户独立持有 mind + memory + SSE + 呼吸循环。
 */

import { resolve as resolvePath } from "node:path";
import { homedir } from "node:os";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { SseHub } from "../server/sse.js";
import type { LayeredMemory, InteractionState } from "../hippocampus/index.js";
import { migrateToLayered } from "../hippocampus/index.js";
import { createInteractionState } from "../prefrontal.js";

const FRONT_TRUTH_JUDGMENT_RULE = "同主题第一句先锁当前前台真值，再谈历史旁证。";
const FRONT_TRUTH_JUDGMENT_RULE_SOURCE = "frontTruthJudgmentLaw/default";

// ─── 类型（从 riverMain 中引用的核心 Mind 类型的简化 re-export）───
export interface Mind {
  beliefs: unknown[];
  knowledge: unknown[];
  userModel: unknown[];
  conversation: unknown[];
  masteredTools: unknown[];
  rules: unknown[];
  scripts: unknown[];
  tasks: unknown[];
  metrics: Record<string, number>;
  cycles: number;
  lastAction: string;
  userLastActiveAt: string;
  goal: unknown;
  predictions: unknown[];
  reflections: unknown[];
  lastCalibrationCycle: number;
}

interface StoredRule {
  rule: string;
  confidence: number;
  source: string;
}

/** 单用户会话状态 */
export class UserSession {
  readonly userId: string;
  readonly dataDir: string;

  mind!: Mind;
  layeredMemory: LayeredMemory | null = null;
  interactionState: InteractionState;
  sseHub: SseHub;

  alive = false;
  lastActiveAt = Date.now();

  private mindFile: string;
  private memoryFile: string;

  constructor(userId: string) {
    this.userId = userId;
    // 每用户独立数据目录
    this.dataDir = resolvePath(homedir(), ".wenlu", "users", userId);
    this.mindFile = resolvePath(this.dataDir, "mind.json");
    this.memoryFile = resolvePath(this.dataDir, "memory.json");
    this.interactionState = createInteractionState();
    this.sseHub = new SseHub();
  }

  /** 初始化：加载或创建 mind + memory */
  async init(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    this.mind = this.ensureDefaultRules(await this.loadMind());
    this.layeredMemory = await this.loadMemory();
    if (!this.layeredMemory) {
      this.layeredMemory = migrateToLayered(this.mind as any);
      await this.saveMemory();
    } else if (syncProceduralRules(this.layeredMemory, this.mind.rules)) {
      await this.saveMemory();
    }
    await this.saveMind();
    this.alive = true;
    this.lastActiveAt = Date.now();
  }

  /** 加载 mind.json */
  private async loadMind(): Promise<Mind> {
    try {
      const raw = await readFile(this.mindFile, "utf-8");
      const loaded = JSON.parse(raw) as Partial<Mind>;
      return {
        beliefs: loaded.beliefs ?? [],
        knowledge: loaded.knowledge ?? [],
        userModel: loaded.userModel ?? [],
        conversation: loaded.conversation ?? [],
        masteredTools: loaded.masteredTools ?? [],
        rules: loaded.rules ?? [],
        scripts: loaded.scripts ?? [],
        tasks: loaded.tasks ?? [],
        metrics: loaded.metrics ?? { sayCount: 0, userRespondedCount: 0, execCount: 0, execSuccessCount: 0, toolCount: 0, knowledgeCount: 0, avgConfidence: 0 },
        cycles: loaded.cycles ?? 0,
        lastAction: loaded.lastAction ?? "",
        userLastActiveAt: loaded.userLastActiveAt ?? new Date().toISOString(),
        goal: loaded.goal ?? null,
        predictions: loaded.predictions ?? [],
        reflections: loaded.reflections ?? [],
        lastCalibrationCycle: loaded.lastCalibrationCycle ?? 0,
      };
    } catch {
      return {
        beliefs: [],
        knowledge: [],
        userModel: [],
        conversation: [],
        masteredTools: [],
        rules: [],
        scripts: [],
        tasks: [],
        metrics: { sayCount: 0, userRespondedCount: 0, execCount: 0, execSuccessCount: 0, toolCount: 0, knowledgeCount: 0, avgConfidence: 0 },
        cycles: 0,
        lastAction: "",
        userLastActiveAt: new Date().toISOString(),
        goal: null,
        predictions: [],
        reflections: [],
        lastCalibrationCycle: 0,
      };
    }
  }

  private ensureDefaultRules(mind: Mind): Mind {
    const rules = normalizeRules(mind.rules);
    if (rules.some((entry) => entry.rule === FRONT_TRUTH_JUDGMENT_RULE)) {
      mind.rules = rules;
      return mind;
    }

    mind.rules = [
      ...rules,
      {
        rule: FRONT_TRUTH_JUDGMENT_RULE,
        confidence: 1,
        source: FRONT_TRUTH_JUDGMENT_RULE_SOURCE,
      },
    ];
    return mind;
  }

  /** 持久化 mind */
  async saveMind(): Promise<void> {
    await writeFile(this.mindFile, JSON.stringify(this.mind, null, 2), "utf-8");
  }

  /** 加载分层记忆 */
  private async loadMemory(): Promise<LayeredMemory | null> {
    try {
      const raw = await readFile(this.memoryFile, "utf-8");
      return JSON.parse(raw) as LayeredMemory;
    } catch {
      return null;
    }
  }

  /** 持久化分层记忆 */
  async saveMemory(): Promise<void> {
    if (!this.layeredMemory) return;
    await writeFile(this.memoryFile, JSON.stringify(this.layeredMemory, null, 2), "utf-8");
  }

  /** 向该用户的 SSE 通道广播事件 */
  emit(ev: Record<string, unknown>): void {
    if (ev.kind === "say" && !ev.time) {
      ev.time = new Date().toISOString();
    }
    this.sseHub.broadcast({ event: "wenlu" as any, data: ev });
  }

  /** 标记活跃 */
  touch(): void {
    this.lastActiveAt = Date.now();
  }

  /** 关闭：保存 + 关闭 SSE */
  async shutdown(): Promise<void> {
    this.alive = false;
    await this.saveMind();
    await this.saveMemory();
    this.sseHub.closeAll();
  }
}

function normalizeRules(rules: unknown[]): StoredRule[] {
  return rules.filter(isStoredRule);
}

function isStoredRule(value: unknown): value is StoredRule {
  if (!value || typeof value !== "object") return false;
  const maybeRule = value as Partial<StoredRule>;
  return typeof maybeRule.rule === "string"
    && typeof maybeRule.confidence === "number"
    && typeof maybeRule.source === "string";
}

function syncProceduralRules(memory: LayeredMemory, rules: unknown[]): boolean {
  const normalizedRules = normalizeRules(rules);
  const hasFrontTruthRule = normalizedRules.some((entry) => entry.rule === FRONT_TRUTH_JUDGMENT_RULE);
  const memoryHasRule = memory.procedural.rules.some((entry) => entry.rule === FRONT_TRUTH_JUDGMENT_RULE);

  if (!hasFrontTruthRule || memoryHasRule) {
    return false;
  }

  memory.procedural.rules = [...memory.procedural.rules, {
    rule: FRONT_TRUTH_JUDGMENT_RULE,
    confidence: 1,
    source: FRONT_TRUTH_JUDGMENT_RULE_SOURCE,
  }];
  return true;
}
