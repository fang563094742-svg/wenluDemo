/**
 * semanticRegistry.ts — 带语义的工具注册表。
 *
 * 替代 riverMain 中的 TOOLS[] 数组和 createToolRegistry()。
 *
 * 每个注册的工具同时具有：
 * - ToolSpec（给 LLM 看的 name/description/parameters）
 * - ToolSemantics（给系统推理用的结构化语义）
 * - ToolHandler（实际执行函数）
 *
 * 规则：
 * - 没有 ToolSemantics 的工具不能参与 pipeline/cache/compose
 * - execute_command 注册时附带 classifyShellCommand 分类器
 * - masteredTools 动态注册时必须推断语义（默认保守假设）
 */

import type { ToolSemantics, ArtifactType, Purity, ShellSubCategory } from "./toolSemantics.js";
import { TOOL_SEMANTICS, classifyShellCommand, canParallelWith, canChain } from "./toolSemantics.js";

// ═══════════════════════════════════════════════════════════════════════
// ToolSpec（给 LLM 的描述，兼容 OpenAI function calling 格式）
// ═══════════════════════════════════════════════════════════════════════

export interface ToolParameter {
  name: string;
  type: string;
  description: string;
  required: boolean;
  enum?: string[];
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: ToolParameter[];
}

// ═══════════════════════════════════════════════════════════════════════
// ToolHandler
// ═══════════════════════════════════════════════════════════════════════

export type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

// ═══════════════════════════════════════════════════════════════════════
// 注册条目
// ═══════════════════════════════════════════════════════════════════════

export interface RegisteredTool {
  spec: ToolSpec;
  semantics: ToolSemantics;
  handler: ToolHandler;
  source: "builtin" | "mastered" | "mcp" | "adapter";
  registeredAt: string;
}

// ═══════════════════════════════════════════════════════════════════════
// SemanticRegistry
// ═══════════════════════════════════════════════════════════════════════

export interface SemanticRegistry {
  register(tool: RegisteredTool): void;
  unregister(name: string): boolean;
  get(name: string): RegisteredTool | undefined;
  getSemantics(name: string): ToolSemantics | undefined;
  all(): RegisteredTool[];
  allSpecs(): ToolSpec[];

  // 语义查询
  findPureRead(): RegisteredTool[];
  findCacheable(): RegisteredTool[];
  findCanParallel(toolA: string, toolB: string): boolean;
  findCanChain(from: string, to: string): boolean;
  findComposablePairs(): Array<[string, string]>;
  findByOutputArtifact(kind: string): RegisteredTool[];
  findByInputArtifact(kind: string): RegisteredTool[];

  // execute_command 二次分类
  classifyShell(cmd: string): { category: ShellSubCategory; purity: Purity; cacheable: boolean };
}

export function createSemanticRegistry(): SemanticRegistry {
  const registry = new Map<string, RegisteredTool>();

  function register(tool: RegisteredTool): void {
    registry.set(tool.spec.name, tool);
  }

  function unregister(name: string): boolean {
    return registry.delete(name);
  }

  function get(name: string): RegisteredTool | undefined {
    return registry.get(name);
  }

  function getSemantics(name: string): ToolSemantics | undefined {
    return registry.get(name)?.semantics;
  }

  function all(): RegisteredTool[] {
    return [...registry.values()];
  }

  function allSpecs(): ToolSpec[] {
    return [...registry.values()].map(t => t.spec);
  }

  function findPureRead(): RegisteredTool[] {
    return [...registry.values()].filter(t => t.semantics.purity === "pure-read");
  }

  function findCacheable(): RegisteredTool[] {
    return [...registry.values()].filter(t => t.semantics.cacheability && t.semantics.freshnessTtlMs > 0);
  }

  function findCanParallel(toolA: string, toolB: string): boolean {
    const a = registry.get(toolA);
    const b = registry.get(toolB);
    if (!a || !b) return false;
    return canParallelWith(a.semantics, b.semantics);
  }

  function findCanChain(from: string, to: string): boolean {
    const f = registry.get(from);
    const t = registry.get(to);
    if (!f || !t) return false;
    return canChain(f.semantics, t.semantics);
  }

  function findComposablePairs(): Array<[string, string]> {
    const tools = [...registry.values()];
    const pairs: Array<[string, string]> = [];
    for (const from of tools) {
      if (!from.semantics.chainable) continue;
      for (const to of tools) {
        if (from.spec.name === to.spec.name) continue;
        if (canChain(from.semantics, to.semantics)) {
          pairs.push([from.spec.name, to.spec.name]);
        }
      }
    }
    return pairs;
  }

  function findByOutputArtifact(kind: string): RegisteredTool[] {
    return [...registry.values()].filter(t =>
      t.semantics.outputArtifacts.some(a => a.kind === kind)
    );
  }

  function findByInputArtifact(kind: string): RegisteredTool[] {
    return [...registry.values()].filter(t =>
      t.semantics.inputArtifacts.some(a => a.kind === kind)
    );
  }

  return {
    register,
    unregister,
    get,
    getSemantics,
    all,
    allSpecs,
    findPureRead,
    findCacheable,
    findCanParallel,
    findCanChain,
    findComposablePairs,
    findByOutputArtifact,
    findByInputArtifact,
    classifyShell: classifyShellCommand,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// 为 mastered tools 推断保守语义
// ═══════════════════════════════════════════════════════════════════════

export function inferSemanticsForMastered(name: string, description: string, script: string): ToolSemantics {
  const hasNetwork = /curl|wget|http|fetch|request/i.test(script);
  const hasFileWrite = /writeFile|>|>>|rm |mv |cp |mkdir/i.test(script);
  const hasShell = /exec|spawn|child_process/i.test(script);

  let purity: Purity = "pure-read";
  if (hasFileWrite || hasShell) purity = "non-idempotent-write";

  return {
    name,
    purity,
    rollbackable: false,
    idempotent: purity === "pure-read",
    determinism: hasNetwork ? "non-deterministic" : "mostly-deterministic",
    cacheability: purity === "pure-read",
    freshnessTtlMs: purity === "pure-read" ? 30000 : 0,
    sourceVolatility: hasNetwork ? "fast-changing" : "slow-changing",
    inputArtifacts: [],
    outputArtifacts: [{ kind: "command-output" }],
    requiresNetwork: hasNetwork,
    requiresUserFocus: false,
    requiresFileSystem: hasFileWrite || hasShell,
    requiresBrowser: false,
    requiresDatabase: false,
    costClass: "cheap",
    typicalDurationMs: 5000,
    conflictKeys: hasFileWrite ? ["filesystem-write"] : [],
    exclusiveResources: [],
    composableAfter: [],
    composableBefore: ["add_knowledge"],
    chainable: purity === "pure-read",
  };
}
