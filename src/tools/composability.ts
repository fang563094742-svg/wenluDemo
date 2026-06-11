/**
 * composability.ts — 工具可组合性推断引擎。
 *
 * 基于 toolSemantics 的类型契约 + artifactBinder 的转换能力，
 * 推断出所有合法的 pipeline 链。
 *
 * 规则：
 * - 只有 chainable=true 的工具才能作为 pipeline 起点
 * - 只有输出类型可以 bind 到下一个工具的输入类型才算合法链
 * - 副作用工具不能出现在 pipeline 中间（只能在末尾）
 * - 最长链限制防止组合爆炸
 */

import type { SemanticRegistry } from "./semanticRegistry.js";
import type { ArtifactBinder } from "./artifactBinder.js";
import type { ToolSemantics, ArtifactTypeKind } from "./toolSemantics.js";

// ═══════════════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════════════

export interface ComposableChain {
  steps: string[];
  bindings: Array<{ from: ArtifactTypeKind; to: ArtifactTypeKind; binderName: string } | null>;
  estimatedDurationMs: number;
  allPureRead: boolean;
}

export interface ComposabilityEngine {
  findChains(maxLength?: number): ComposableChain[];
  findChainsFrom(startTool: string, maxLength?: number): ComposableChain[];
  findChainsTo(endTool: string, maxLength?: number): ComposableChain[];
  canCompose(from: string, to: string): { composable: boolean; binding: string | null; reason?: string };
  suggestNextTools(afterTool: string): string[];
}

// ═══════════════════════════════════════════════════════════════════════
// 实现
// ═══════════════════════════════════════════════════════════════════════

export function createComposabilityEngine(
  registry: SemanticRegistry,
  binder: ArtifactBinder,
): ComposabilityEngine {
  const MAX_CHAIN_LENGTH = 5;

  function canCompose(from: string, to: string): { composable: boolean; binding: string | null; reason?: string } {
    const fromSem = registry.getSemantics(from);
    const toSem = registry.getSemantics(to);
    if (!fromSem || !toSem) return { composable: false, binding: null, reason: "unknown-tool" };
    if (!fromSem.chainable) return { composable: false, binding: null, reason: "source-not-chainable" };

    // 直接类型匹配
    for (const outA of fromSem.outputArtifacts) {
      for (const inA of toSem.inputArtifacts) {
        if (outA.kind === inA.kind) {
          return { composable: true, binding: null }; // 直接兼容，不需要 binder
        }
      }
    }

    // 通过 binder 转换
    for (const outA of fromSem.outputArtifacts) {
      for (const inA of toSem.inputArtifacts) {
        const rule = binder.getBinder(outA.kind, inA.kind);
        if (rule) {
          return { composable: true, binding: rule.extractorName };
        }
      }
    }

    return { composable: false, binding: null, reason: "type-incompatible" };
  }

  function findChainsFrom(startTool: string, maxLength: number = MAX_CHAIN_LENGTH): ComposableChain[] {
    const chains: ComposableChain[] = [];
    const startSem = registry.getSemantics(startTool);
    if (!startSem || !startSem.chainable) return chains;

    function dfs(
      current: string,
      path: string[],
      bindings: Array<{ from: ArtifactTypeKind; to: ArtifactTypeKind; binderName: string } | null>,
      visited: Set<string>,
    ): void {
      if (path.length >= 2) {
        // 计算估计时间
        const duration = path.reduce((sum, tool) => {
          const sem = registry.getSemantics(tool);
          return sum + (sem?.typicalDurationMs ?? 5000);
        }, 0);
        const allPure = path.every(t => {
          const sem = registry.getSemantics(t);
          return sem?.purity === "pure-read";
        });
        chains.push({ steps: [...path], bindings: [...bindings], estimatedDurationMs: duration, allPureRead: allPure });
      }
      if (path.length >= maxLength) return;

      const currentSem = registry.getSemantics(current);
      if (!currentSem) return;

      const allTools = registry.all();
      for (const tool of allTools) {
        if (visited.has(tool.spec.name)) continue;
        const result = canCompose(current, tool.spec.name);
        if (result.composable) {
          // pipeline 中间步骤必须是 pure-read 或 idempotent
          const midSem = tool.semantics;
          if (path.length < maxLength - 1) {
            if (midSem.purity === "destructive" || midSem.purity === "non-idempotent-write") continue;
          }

          visited.add(tool.spec.name);
          const bindingEntry = result.binding ? {
            from: currentSem.outputArtifacts[0]?.kind ?? "command-output" as ArtifactTypeKind,
            to: midSem.inputArtifacts[0]?.kind ?? "command-output" as ArtifactTypeKind,
            binderName: result.binding,
          } : null;
          path.push(tool.spec.name);
          bindings.push(bindingEntry);
          dfs(tool.spec.name, path, bindings, visited);
          path.pop();
          bindings.pop();
          visited.delete(tool.spec.name);
        }
      }
    }

    const visited = new Set([startTool]);
    dfs(startTool, [startTool], [], visited);
    return chains;
  }

  function findChainsTo(endTool: string, maxLength: number = MAX_CHAIN_LENGTH): ComposableChain[] {
    const allChains = findChains(maxLength);
    return allChains.filter(c => c.steps[c.steps.length - 1] === endTool);
  }

  function findChains(maxLength: number = MAX_CHAIN_LENGTH): ComposableChain[] {
    const allTools = registry.all();
    const chains: ComposableChain[] = [];
    for (const tool of allTools) {
      if (tool.semantics.chainable) {
        chains.push(...findChainsFrom(tool.spec.name, maxLength));
      }
    }
    return chains;
  }

  function suggestNextTools(afterTool: string): string[] {
    const sem = registry.getSemantics(afterTool);
    if (!sem) return [];
    const suggestions: string[] = [];
    const allTools = registry.all();
    for (const tool of allTools) {
      if (tool.spec.name === afterTool) continue;
      if (canCompose(afterTool, tool.spec.name).composable) {
        suggestions.push(tool.spec.name);
      }
    }
    return suggestions;
  }

  return { findChains, findChainsFrom, findChainsTo, canCompose, suggestNextTools };
}
