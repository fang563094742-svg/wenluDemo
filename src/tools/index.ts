/**
 * tools/index.ts — 工具语义层统一出口。
 */

export type { ToolSemantics, ArtifactType, ArtifactTypeKind, Purity, CostClass, Determinism, ShellSubCategory } from "./toolSemantics.js";
export { TOOL_SEMANTICS, classifyShellCommand, isPureRead, isCacheable, canParallelWith, canChain } from "./toolSemantics.js";

export type { ToolSpec, ToolParameter, ToolHandler, RegisteredTool, SemanticRegistry } from "./semanticRegistry.js";
export { createSemanticRegistry, inferSemanticsForMastered } from "./semanticRegistry.js";

export type { ConflictReason, ConflictResult, ConflictDetector } from "./conflictDetector.js";
export { createConflictDetector } from "./conflictDetector.js";

export type { BinderRule, ArtifactBinder } from "./artifactBinder.js";
export { createArtifactBinder, BUILTIN_BINDERS } from "./artifactBinder.js";

export type { ComposableChain, ComposabilityEngine } from "./composability.js";
export { createComposabilityEngine } from "./composability.js";
