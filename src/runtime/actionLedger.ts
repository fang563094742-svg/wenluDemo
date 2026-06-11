/**
 * actionLedger.ts — 追加式行动账本。
 *
 * 与 agentState 的关系：
 * - agentState = 当前世界面貌（快照）
 * - actionLedger = 发生过什么（历史流水）
 *
 * 设计要点：
 * 1. NDJSON（换行分隔 JSON）格式——append-only，永不回写
 * 2. 每条 entry 自包含（可独立反序列化）
 * 3. 支持按时间范围/类型/来源高效检索
 * 4. 大 blob（命令输出/文件 diff/截图）不内联，存 artifactStore 并引用 id
 * 5. 从 eventBus 自动订阅 tool-invoked/tool-completed/tool-failed 事件
 */

import { appendFile, readFile, stat, mkdir } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import type { EventBus, AgentEvent } from "./eventBus.js";

// ═══════════════════════════════════════════════════════════════════════
// LedgerEntry 类型
// ═══════════════════════════════════════════════════════════════════════

export type LedgerSource =
  | "breathe"
  | "executor"
  | "task-line"
  | "user-input"
  | "reflect"
  | "evolve"
  | "verify"
  | "perceive"
  | "mirror"
  | "budget"
  | "lifecycle";

export interface SideEffect {
  kind: "file-write" | "file-delete" | "network-request" | "state-mutation" | "process-spawn" | "user-notification";
  target: string;
  reversible: boolean;
  artifactRef?: string;
}

export interface LedgerEntry {
  id: string;
  timestamp: string;
  cycle: number;
  source: LedgerSource;
  action: string;
  input: unknown;
  /** output 摘要（<4KB），大结果存 artifactStore */
  outputSummary: string;
  /** 指向 artifactStore 中的完整结果（如果 output > 4KB） */
  outputArtifactRef?: string;
  durationMs: number;
  success: boolean;
  errorMessage?: string;
  sideEffects: SideEffect[];
  rollbackable: boolean;
  /** 工具语义分类（来自 toolSemantics.purity） */
  purity?: "pure-read" | "idempotent-write" | "non-idempotent-write" | "destructive";
}

// ═══════════════════════════════════════════════════════════════════════
// ActionLedger 接口
// ═══════════════════════════════════════════════════════════════════════

export interface ActionLedger {
  append(entry: LedgerEntry): Promise<void>;
  query(opts: LedgerQuery): Promise<LedgerEntry[]>;
  count(): Promise<number>;
  tail(n: number): Promise<LedgerEntry[]>;
  since(timestamp: string): Promise<LedgerEntry[]>;
}

export interface LedgerQuery {
  since?: string;
  until?: string;
  source?: LedgerSource;
  action?: string;
  onlyFailed?: boolean;
  limit?: number;
}

// ═══════════════════════════════════════════════════════════════════════
// 基于文件的 NDJSON 实现
// ═══════════════════════════════════════════════════════════════════════

export function createActionLedger(dataDir: string): ActionLedger {
  const ledgerPath = resolvePath(dataDir, "action-ledger.ndjson");
  let entryCount = -1; // lazy init

  async function ensureDir(): Promise<void> {
    try {
      await mkdir(dataDir, { recursive: true });
    } catch { /* already exists */ }
  }

  async function append(entry: LedgerEntry): Promise<void> {
    await ensureDir();
    const line = JSON.stringify(entry) + "\n";
    await appendFile(ledgerPath, line, "utf-8");
    if (entryCount >= 0) entryCount++;
  }

  async function readAll(): Promise<LedgerEntry[]> {
    try {
      const content = await readFile(ledgerPath, "utf-8");
      const lines = content.trim().split("\n").filter(l => l.length > 0);
      entryCount = lines.length;
      return lines.map(l => JSON.parse(l) as LedgerEntry);
    } catch {
      entryCount = 0;
      return [];
    }
  }

  async function query(opts: LedgerQuery): Promise<LedgerEntry[]> {
    let entries = await readAll();
    if (opts.since) entries = entries.filter(e => e.timestamp >= opts.since!);
    if (opts.until) entries = entries.filter(e => e.timestamp <= opts.until!);
    if (opts.source) entries = entries.filter(e => e.source === opts.source);
    if (opts.action) entries = entries.filter(e => e.action === opts.action);
    if (opts.onlyFailed) entries = entries.filter(e => !e.success);
    if (opts.limit) entries = entries.slice(-opts.limit);
    return entries;
  }

  async function count(): Promise<number> {
    if (entryCount < 0) await readAll();
    return entryCount;
  }

  async function tail(n: number): Promise<LedgerEntry[]> {
    const all = await readAll();
    return all.slice(-n);
  }

  async function since(timestamp: string): Promise<LedgerEntry[]> {
    return query({ since: timestamp });
  }

  return { append, query, count, tail, since };
}

// ═══════════════════════════════════════════════════════════════════════
// 自动接线：从 eventBus 订阅工具相关事件，自动记账
// ═══════════════════════════════════════════════════════════════════════

export function wireLedgerToEventBus(ledger: ActionLedger, eventBus: EventBus): () => void {
  const unsubscribers: Array<() => void> = [];

  const toolHandler = (event: AgentEvent) => {
    if (event.kind === "tool-completed" || event.kind === "tool-failed") {
      const p = event.payload as Record<string, unknown>;
      const entry: LedgerEntry = {
        id: (p.id as string) ?? `le_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        timestamp: event.timestamp,
        cycle: event.cycle ?? 0,
        source: (p.source as LedgerSource) ?? "executor",
        action: (p.action as string) ?? "unknown",
        input: p.input,
        outputSummary: truncate((p.output as string) ?? "", 4000),
        outputArtifactRef: (p.artifactRef as string) ?? undefined,
        durationMs: (p.durationMs as number) ?? 0,
        success: event.kind === "tool-completed",
        errorMessage: event.kind === "tool-failed" ? (p.error as string) : undefined,
        sideEffects: (p.sideEffects as SideEffect[]) ?? [],
        rollbackable: (p.rollbackable as boolean) ?? false,
        purity: p.purity as LedgerEntry["purity"],
      };
      ledger.append(entry).catch(() => { /* non-critical */ });
    }
  };

  unsubscribers.push(eventBus.on("tool-completed", toolHandler));
  unsubscribers.push(eventBus.on("tool-failed", toolHandler));

  return () => { unsubscribers.forEach(u => u()); };
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 20) + `...[truncated ${s.length - max + 20}b]`;
}
