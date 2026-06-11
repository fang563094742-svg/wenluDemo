/**
 * conflictDetector.ts — 工具冲突检测器。
 *
 * 职责：
 * 1. O(1) 判断两个工具是否可并行执行
 * 2. 检测资源互斥死锁
 * 3. 为调度器提供冲突图
 */

import type { SemanticRegistry } from "./semanticRegistry.js";
import type { ToolSemantics } from "./toolSemantics.js";

// ═══════════════════════════════════════════════════════════════════════
// ConflictDetector
// ═══════════════════════════════════════════════════════════════════════

export interface ConflictReason {
  conflictKey?: string;
  exclusiveResource?: string;
  bothHaveSideEffects?: boolean;
}

export interface ConflictResult {
  canParallel: boolean;
  reasons: ConflictReason[];
}

export interface ConflictDetector {
  check(toolA: string, toolB: string): ConflictResult;
  checkSemantics(a: ToolSemantics, b: ToolSemantics): ConflictResult;
  conflictGraph(): Map<string, Set<string>>;
  maxParallelSet(tools: string[]): string[][];
}

export function createConflictDetector(registry: SemanticRegistry): ConflictDetector {
  function checkSemantics(a: ToolSemantics, b: ToolSemantics): ConflictResult {
    const reasons: ConflictReason[] = [];

    // 冲突键重叠
    const aKeys = new Set(a.conflictKeys);
    for (const key of b.conflictKeys) {
      if (aKeys.has(key)) {
        reasons.push({ conflictKey: key });
      }
    }

    // 互斥资源重叠
    const aExcl = new Set(a.exclusiveResources);
    for (const res of b.exclusiveResources) {
      if (aExcl.has(res)) {
        reasons.push({ exclusiveResource: res });
      }
    }

    // 双方都有副作用 → 默认互斥
    const aWrite = a.purity !== "pure-read";
    const bWrite = b.purity !== "pure-read";
    if (aWrite && bWrite) {
      reasons.push({ bothHaveSideEffects: true });
    }

    return {
      canParallel: reasons.length === 0,
      reasons,
    };
  }

  function check(toolA: string, toolB: string): ConflictResult {
    const a = registry.getSemantics(toolA);
    const b = registry.getSemantics(toolB);
    if (!a || !b) return { canParallel: false, reasons: [{ conflictKey: "unknown-tool" }] };
    return checkSemantics(a, b);
  }

  function conflictGraph(): Map<string, Set<string>> {
    const tools = registry.all();
    const graph = new Map<string, Set<string>>();

    for (const t of tools) {
      graph.set(t.spec.name, new Set());
    }

    for (let i = 0; i < tools.length; i++) {
      for (let j = i + 1; j < tools.length; j++) {
        const result = checkSemantics(tools[i].semantics, tools[j].semantics);
        if (!result.canParallel) {
          graph.get(tools[i].spec.name)!.add(tools[j].spec.name);
          graph.get(tools[j].spec.name)!.add(tools[i].spec.name);
        }
      }
    }

    return graph;
  }

  // 贪心着色：找出最大可并行子集组
  function maxParallelSet(tools: string[]): string[][] {
    const graph = conflictGraph();
    const colors: string[][] = [];
    const colored = new Set<string>();

    for (const tool of tools) {
      if (colored.has(tool)) continue;
      const group = [tool];
      colored.add(tool);
      const conflicts = graph.get(tool) ?? new Set<string>();

      for (const other of tools) {
        if (colored.has(other)) continue;
        const otherConflicts = graph.get(other) ?? new Set<string>();
        // 检查 other 是否和 group 内所有工具兼容
        const compatible = group.every(g => !otherConflicts.has(g) && !(graph.get(g)?.has(other)));
        if (compatible) {
          group.push(other);
          colored.add(other);
        }
      }
      colors.push(group);
    }

    return colors;
  }

  return { check, checkSemantics, conflictGraph, maxParallelSet };
}
