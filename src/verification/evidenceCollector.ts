/**
 * evidenceCollector.ts — 证据结构化采集与存储。
 *
 * 职责：
 * 1. 将 verification 产出的 CollectedEvidence 结构化归档
 * 2. 为 reflect/evolve 提供"历史证据查询"能力
 * 3. 大 blob（截图/diff/长输出）存入 artifactStore，这里只存索引
 */

import type { CollectedEvidence, VerificationResult } from "./assertionTypes.js";

// ═══════════════════════════════════════════════════════════════════════
// Evidence Store
// ═══════════════════════════════════════════════════════════════════════

export interface EvidenceQuery {
  taskId?: string;
  since?: string;          // ISO timestamp
  probeType?: string;
  passed?: boolean;
  limit?: number;
}

export interface EvidenceEntry {
  taskId: string;
  assertionId: string;
  timestamp: string;
  passed: boolean;
  evidence: CollectedEvidence;
}

export interface FailureCluster {
  pattern: string;
  count: number;
  latestTimestamp: string;
  sampleTaskIds: string[];
  sampleAssertionIds: string[];
}

export interface EvidenceCollector {
  store(result: VerificationResult): void;
  query(q: EvidenceQuery): EvidenceEntry[];
  recentFailures(limit?: number): EvidenceEntry[];
  recentFailureClusters(limit?: number): FailureCluster[];
  successRate(taskId?: string): number;
  clear(): void;
  size(): number;
}

function normalizeFailurePattern(entry: EvidenceEntry): string {
  const blob = `${entry.assertionId} ${(entry.evidence as { summary?: string }).summary ?? ""} ${(entry.evidence as { detail?: string }).detail ?? ""}`.toLowerCase();
  if (/ocr|tesseract|ocrmac|screen|screenshot|棋盘|坐标|盘面/.test(blob)) return "missing-ocr-or-board-truth";
  if (/timeout|timed out|超时/.test(blob)) return "timeout";
  if (/permission|denied|授权|automation/.test(blob)) return "permission-denied";
  return entry.evidence.type || "unknown";
}

export function createEvidenceCollector(maxEntries: number = 5000): EvidenceCollector {
  const entries: EvidenceEntry[] = [];

  function store(result: VerificationResult): void {
    for (const ar of result.assertions) {
      entries.push({
        taskId: result.taskId,
        assertionId: ar.id,
        timestamp: ar.evidence.timestamp,
        passed: ar.passed,
        evidence: ar.evidence,
      });
    }
    while (entries.length > maxEntries) {
      entries.shift();
    }
  }

  function query(q: EvidenceQuery): EvidenceEntry[] {
    let results = entries;

    if (q.taskId) results = results.filter((e) => e.taskId === q.taskId);
    if (q.since) results = results.filter((e) => e.timestamp >= q.since!);
    if (q.probeType) results = results.filter((e) => e.evidence.type === q.probeType);
    if (q.passed !== undefined) results = results.filter((e) => e.passed === q.passed);
    if (q.limit) results = results.slice(-q.limit);

    return results;
  }

  function recentFailures(limit: number = 20): EvidenceEntry[] {
    return query({ passed: false, limit });
  }

  function recentFailureClusters(limit: number = 20): FailureCluster[] {
    const failures = recentFailures(limit);
    const grouped = new Map<string, FailureCluster>();

    for (const entry of failures) {
      const pattern = normalizeFailurePattern(entry);
      const current = grouped.get(pattern);
      if (current) {
        current.count += 1;
        if (entry.timestamp > current.latestTimestamp) current.latestTimestamp = entry.timestamp;
        if (!current.sampleTaskIds.includes(entry.taskId) && current.sampleTaskIds.length < 3) current.sampleTaskIds.push(entry.taskId);
        if (!current.sampleAssertionIds.includes(entry.assertionId) && current.sampleAssertionIds.length < 3) current.sampleAssertionIds.push(entry.assertionId);
        continue;
      }
      grouped.set(pattern, {
        pattern,
        count: 1,
        latestTimestamp: entry.timestamp,
        sampleTaskIds: [entry.taskId],
        sampleAssertionIds: [entry.assertionId],
      });
    }

    return [...grouped.values()].sort((a, b) => b.count - a.count || b.latestTimestamp.localeCompare(a.latestTimestamp));
  }

  function successRate(taskId?: string): number {
    const relevant = taskId ? entries.filter((e) => e.taskId === taskId) : entries;
    if (relevant.length === 0) return 0;
    return relevant.filter((e) => e.passed).length / relevant.length;
  }

  function clear(): void {
    entries.length = 0;
  }

  function size(): number {
    return entries.length;
  }

  return { store, query, recentFailures, recentFailureClusters, successRate, clear, size };
}
