/**
 * toolSemantics.ts — 工具语义元数据系统。
 *
 * 为什么必须先于 pipeline/cache/composer/conflict-detection 存在：
 * - 没有语义的工具组合是"碰运气"，不是"组合能力"
 * - 没有 purity 标注的并发执行是赌博
 * - 没有冲突键的调度器会产出不可复现的竞态
 *
 * 设计要点：
 * 1. 每个工具必须声明完整语义，否则不能被 pipeline/composer 使用
 * 2. execute_command 不是一个工具——它是工具虚拟机，需要二次分类
 * 3. 补充 determinism/freshnessTtl/cacheability 字段（覆盖 web_search 等非确定性工具）
 * 4. artifactType 是 typed I/O 契约，后续 composer 基于它做合法性推断
 */

// ═══════════════════════════════════════════════════════════════════════
// Artifact Type（工具 I/O 的类型契约）
// ═══════════════════════════════════════════════════════════════════════

export type ArtifactTypeKind =
  | "file-content"
  | "directory-listing"
  | "command-output"
  | "search-results"
  | "web-page-content"
  | "structured-json"
  | "user-response"
  | "verification-result"
  | "state-mutation"
  | "notification"
  | "binary-data"
  | "path-list";

export interface ArtifactType {
  kind: ArtifactTypeKind;
  schema?: string;        // JSON Schema $ref（如果是 structured-json）
  pathPattern?: string;   // glob 模式（如果是 file-content）
  description?: string;   // 人类可读描述
}

// ═══════════════════════════════════════════════════════════════════════
// 核心语义类型
// ═══════════════════════════════════════════════════════════════════════

export type Purity = "pure-read" | "idempotent-write" | "non-idempotent-write" | "destructive";
export type CostClass = "free" | "cheap" | "moderate" | "expensive";
export type Determinism = "deterministic" | "mostly-deterministic" | "non-deterministic";

export interface ToolSemantics {
  name: string;

  // === 副作用属性 ===
  purity: Purity;
  rollbackable: boolean;
  rollbackMethod?: string;
  idempotent: boolean;

  // === 确定性与缓存 ===
  determinism: Determinism;
  cacheability: boolean;          // 结果是否可缓存
  freshnessTtlMs: number;        // 缓存有效期（0 = 不可缓存）
  sourceVolatility: "static" | "slow-changing" | "fast-changing" | "real-time";

  // === I/O 类型契约 ===
  inputArtifacts: ArtifactType[];
  outputArtifacts: ArtifactType[];

  // === 资源要求 ===
  requiresNetwork: boolean;
  requiresUserFocus: boolean;
  requiresFileSystem: boolean;
  requiresBrowser: boolean;
  requiresDatabase: boolean;
  costClass: CostClass;
  typicalDurationMs: number;

  // === 冲突与互斥 ===
  conflictKeys: string[];
  exclusiveResources: string[];

  // === 组合性 ===
  composableAfter: string[];
  composableBefore: string[];
  chainable: boolean;

  // === execute_command 二次分类（仅对万能工具适用）===
  shellSubCategory?: ShellSubCategory;
}

export type ShellSubCategory =
  | "shell-read"
  | "shell-write"
  | "shell-network"
  | "shell-package"
  | "shell-process"
  | "shell-git"
  | "shell-unknown";

// ═══════════════════════════════════════════════════════════════════════
// 现有工具的完整语义标注
// ═══════════════════════════════════════════════════════════════════════

export const TOOL_SEMANTICS: Record<string, ToolSemantics> = {
  read_file: {
    name: "read_file",
    purity: "pure-read",
    rollbackable: true,
    idempotent: true,
    determinism: "deterministic",
    cacheability: true,
    freshnessTtlMs: 30000,
    sourceVolatility: "slow-changing",
    inputArtifacts: [{ kind: "path-list", description: "文件路径" }],
    outputArtifacts: [{ kind: "file-content" }],
    requiresNetwork: false,
    requiresUserFocus: false,
    requiresFileSystem: true,
    requiresBrowser: false,
    requiresDatabase: false,
    costClass: "free",
    typicalDurationMs: 50,
    conflictKeys: [],
    exclusiveResources: [],
    composableAfter: ["list_directory"],
    composableBefore: ["write_file", "add_knowledge", "add_belief"],
    chainable: true,
  },

  write_file: {
    name: "write_file",
    purity: "non-idempotent-write",
    rollbackable: true,
    rollbackMethod: "restore-from-checkpoint",
    idempotent: false,
    determinism: "deterministic",
    cacheability: false,
    freshnessTtlMs: 0,
    sourceVolatility: "static",
    inputArtifacts: [{ kind: "file-content" }, { kind: "path-list" }],
    outputArtifacts: [{ kind: "state-mutation", description: "文件系统变更" }],
    requiresNetwork: false,
    requiresUserFocus: false,
    requiresFileSystem: true,
    requiresBrowser: false,
    requiresDatabase: false,
    costClass: "free",
    typicalDurationMs: 100,
    conflictKeys: ["filesystem-write"],
    exclusiveResources: [],
    composableAfter: ["read_file"],
    composableBefore: ["read_file", "execute_command"],
    chainable: false,
  },

  list_directory: {
    name: "list_directory",
    purity: "pure-read",
    rollbackable: true,
    idempotent: true,
    determinism: "mostly-deterministic",
    cacheability: true,
    freshnessTtlMs: 30000,
    sourceVolatility: "slow-changing",
    inputArtifacts: [{ kind: "path-list", description: "目录路径" }],
    outputArtifacts: [{ kind: "directory-listing" }, { kind: "path-list" }],
    requiresNetwork: false,
    requiresUserFocus: false,
    requiresFileSystem: true,
    requiresBrowser: false,
    requiresDatabase: false,
    costClass: "free",
    typicalDurationMs: 50,
    conflictKeys: [],
    exclusiveResources: [],
    composableAfter: [],
    composableBefore: ["read_file"],
    chainable: true,
  },

  execute_command: {
    name: "execute_command",
    purity: "non-idempotent-write",  // 最保守假设
    rollbackable: false,
    idempotent: false,
    determinism: "non-deterministic",
    cacheability: false,
    freshnessTtlMs: 0,
    sourceVolatility: "real-time",
    inputArtifacts: [],
    outputArtifacts: [{ kind: "command-output" }],
    requiresNetwork: false,  // 动态决定
    requiresUserFocus: false,
    requiresFileSystem: true,
    requiresBrowser: false,
    requiresDatabase: false,
    costClass: "cheap",
    typicalDurationMs: 3000,
    conflictKeys: ["shell-session"],
    exclusiveResources: [],
    composableAfter: ["read_file", "list_directory"],
    composableBefore: ["add_knowledge", "master_tool"],
    chainable: true,
    shellSubCategory: "shell-unknown",
  },

  web_search: {
    name: "web_search",
    purity: "pure-read",
    rollbackable: true,
    idempotent: true,
    determinism: "non-deterministic",
    cacheability: true,
    freshnessTtlMs: 300000,  // 5min
    sourceVolatility: "fast-changing",
    inputArtifacts: [],
    outputArtifacts: [{ kind: "search-results" }],
    requiresNetwork: true,
    requiresUserFocus: false,
    requiresFileSystem: false,
    requiresBrowser: false,
    requiresDatabase: false,
    costClass: "moderate",
    typicalDurationMs: 8000,
    conflictKeys: [],
    exclusiveResources: [],
    composableAfter: [],
    composableBefore: ["browse_url", "add_knowledge"],
    chainable: true,
  },

  browse_url: {
    name: "browse_url",
    purity: "pure-read",
    rollbackable: true,
    idempotent: true,
    determinism: "non-deterministic",
    cacheability: true,
    freshnessTtlMs: 300000,
    sourceVolatility: "fast-changing",
    inputArtifacts: [{ kind: "search-results", description: "URL 来源" }],
    outputArtifacts: [{ kind: "web-page-content" }],
    requiresNetwork: true,
    requiresUserFocus: false,
    requiresFileSystem: false,
    requiresBrowser: true,
    requiresDatabase: false,
    costClass: "moderate",
    typicalDurationMs: 12000,
    conflictKeys: ["browser-session"],
    exclusiveResources: ["browser-session"],
    composableAfter: ["web_search"],
    composableBefore: ["add_knowledge"],
    chainable: true,
  },

  say_to_user: {
    name: "say_to_user",
    purity: "non-idempotent-write",
    rollbackable: false,
    idempotent: false,
    determinism: "deterministic",
    cacheability: false,
    freshnessTtlMs: 0,
    sourceVolatility: "static",
    inputArtifacts: [],
    outputArtifacts: [{ kind: "notification" }],
    requiresNetwork: false,
    requiresUserFocus: true,
    requiresFileSystem: false,
    requiresBrowser: false,
    requiresDatabase: false,
    costClass: "free",
    typicalDurationMs: 100,
    conflictKeys: ["user-attention"],
    exclusiveResources: ["user-attention"],
    composableAfter: ["web_search", "read_file", "execute_command"],
    composableBefore: [],
    chainable: false,
  },

  ask_user: {
    name: "ask_user",
    purity: "pure-read",
    rollbackable: true,
    idempotent: false,  // 用户每次回答可能不同
    determinism: "non-deterministic",
    cacheability: false,
    freshnessTtlMs: 0,
    sourceVolatility: "real-time",
    inputArtifacts: [],
    outputArtifacts: [{ kind: "user-response" }],
    requiresNetwork: false,
    requiresUserFocus: true,
    requiresFileSystem: false,
    requiresBrowser: false,
    requiresDatabase: false,
    costClass: "free",
    typicalDurationMs: 30000,  // 等用户回复
    conflictKeys: ["user-attention"],
    exclusiveResources: ["user-attention"],
    composableAfter: [],
    composableBefore: ["add_belief", "understand_user"],
    chainable: true,
  },

  add_belief: {
    name: "add_belief",
    purity: "idempotent-write",
    rollbackable: true,
    rollbackMethod: "correct-belief",
    idempotent: true,
    determinism: "deterministic",
    cacheability: false,
    freshnessTtlMs: 0,
    sourceVolatility: "static",
    inputArtifacts: [{ kind: "user-response" }, { kind: "file-content" }, { kind: "command-output" }],
    outputArtifacts: [{ kind: "state-mutation", description: "belief 新增" }],
    requiresNetwork: false,
    requiresUserFocus: false,
    requiresFileSystem: false,
    requiresBrowser: false,
    requiresDatabase: false,
    costClass: "free",
    typicalDurationMs: 10,
    conflictKeys: [],
    exclusiveResources: [],
    composableAfter: ["ask_user", "read_file", "execute_command", "web_search"],
    composableBefore: [],
    chainable: false,
  },

  add_knowledge: {
    name: "add_knowledge",
    purity: "idempotent-write",
    rollbackable: true,
    idempotent: true,
    determinism: "deterministic",
    cacheability: false,
    freshnessTtlMs: 0,
    sourceVolatility: "static",
    inputArtifacts: [{ kind: "web-page-content" }, { kind: "file-content" }, { kind: "command-output" }, { kind: "search-results" }],
    outputArtifacts: [{ kind: "state-mutation", description: "knowledge 新增" }],
    requiresNetwork: false,
    requiresUserFocus: false,
    requiresFileSystem: false,
    requiresBrowser: false,
    requiresDatabase: false,
    costClass: "free",
    typicalDurationMs: 10,
    conflictKeys: [],
    exclusiveResources: [],
    composableAfter: ["web_search", "browse_url", "read_file", "execute_command"],
    composableBefore: [],
    chainable: false,
  },

  understand_user: {
    name: "understand_user",
    purity: "idempotent-write",
    rollbackable: true,
    idempotent: true,
    determinism: "deterministic",
    cacheability: false,
    freshnessTtlMs: 0,
    sourceVolatility: "static",
    inputArtifacts: [{ kind: "user-response" }],
    outputArtifacts: [{ kind: "state-mutation", description: "userInsight 新增" }],
    requiresNetwork: false,
    requiresUserFocus: false,
    requiresFileSystem: false,
    requiresBrowser: false,
    requiresDatabase: false,
    costClass: "free",
    typicalDurationMs: 10,
    conflictKeys: [],
    exclusiveResources: [],
    composableAfter: ["ask_user"],
    composableBefore: [],
    chainable: false,
  },

  declare_verifiable_task: {
    name: "declare_verifiable_task",
    purity: "idempotent-write",
    rollbackable: true,
    idempotent: true,
    determinism: "deterministic",
    cacheability: false,
    freshnessTtlMs: 0,
    sourceVolatility: "static",
    inputArtifacts: [],
    outputArtifacts: [{ kind: "state-mutation", description: "verifiableTask 新增" }],
    requiresNetwork: false,
    requiresUserFocus: false,
    requiresFileSystem: false,
    requiresBrowser: false,
    requiresDatabase: false,
    costClass: "free",
    typicalDurationMs: 10,
    conflictKeys: [],
    exclusiveResources: [],
    composableAfter: ["execute_command", "web_search"],
    composableBefore: ["verify_task"],
    chainable: false,
  },

  verify_task: {
    name: "verify_task",
    purity: "pure-read",
    rollbackable: true,
    idempotent: true,
    determinism: "mostly-deterministic",
    cacheability: false,
    freshnessTtlMs: 0,
    sourceVolatility: "real-time",
    inputArtifacts: [{ kind: "state-mutation", description: "verifiable task ref" }],
    outputArtifacts: [{ kind: "verification-result" }],
    requiresNetwork: false,  // 取决于 verifyCmd
    requiresUserFocus: false,
    requiresFileSystem: true,
    requiresBrowser: false,
    requiresDatabase: false,
    costClass: "cheap",
    typicalDurationMs: 5000,
    conflictKeys: [],
    exclusiveResources: [],
    composableAfter: ["declare_verifiable_task"],
    composableBefore: [],
    chainable: false,
  },

  make_prediction: {
    name: "make_prediction",
    purity: "idempotent-write",
    rollbackable: true,
    idempotent: true,
    determinism: "deterministic",
    cacheability: false,
    freshnessTtlMs: 0,
    sourceVolatility: "static",
    inputArtifacts: [],
    outputArtifacts: [{ kind: "state-mutation", description: "prediction 新增" }],
    requiresNetwork: false,
    requiresUserFocus: false,
    requiresFileSystem: false,
    requiresBrowser: false,
    requiresDatabase: false,
    costClass: "free",
    typicalDurationMs: 10,
    conflictKeys: [],
    exclusiveResources: [],
    composableAfter: [],
    composableBefore: [],
    chainable: false,
  },

  forge_capability: {
    name: "forge_capability",
    purity: "non-idempotent-write",
    rollbackable: true,
    rollbackMethod: "remove-capability",
    idempotent: false,
    determinism: "non-deterministic",
    cacheability: false,
    freshnessTtlMs: 0,
    sourceVolatility: "static",
    inputArtifacts: [],
    outputArtifacts: [{ kind: "state-mutation", description: "新能力锻造" }],
    requiresNetwork: false,
    requiresUserFocus: false,
    requiresFileSystem: true,
    requiresBrowser: false,
    requiresDatabase: false,
    costClass: "moderate",
    typicalDurationMs: 15000,
    conflictKeys: ["capability-forge"],
    exclusiveResources: ["capability-forge"],
    composableAfter: ["execute_command"],
    composableBefore: [],
    chainable: false,
  },

  master_tool: {
    name: "master_tool",
    purity: "idempotent-write",
    rollbackable: true,
    idempotent: true,
    determinism: "deterministic",
    cacheability: false,
    freshnessTtlMs: 0,
    sourceVolatility: "static",
    inputArtifacts: [],
    outputArtifacts: [{ kind: "state-mutation", description: "工具注册" }],
    requiresNetwork: false,
    requiresUserFocus: false,
    requiresFileSystem: false,
    requiresBrowser: false,
    requiresDatabase: false,
    costClass: "free",
    typicalDurationMs: 10,
    conflictKeys: [],
    exclusiveResources: [],
    composableAfter: ["forge_capability", "execute_command"],
    composableBefore: [],
    chainable: false,
  },

  grow_sensor: {
    name: "grow_sensor",
    purity: "non-idempotent-write",
    rollbackable: true,
    rollbackMethod: "remove-sensor",
    idempotent: false,
    determinism: "non-deterministic",
    cacheability: false,
    freshnessTtlMs: 0,
    sourceVolatility: "static",
    inputArtifacts: [],
    outputArtifacts: [{ kind: "state-mutation", description: "新传感器" }],
    requiresNetwork: false,
    requiresUserFocus: false,
    requiresFileSystem: true,
    requiresBrowser: false,
    requiresDatabase: false,
    costClass: "cheap",
    typicalDurationMs: 5000,
    conflictKeys: ["sensor-growth"],
    exclusiveResources: [],
    composableAfter: [],
    composableBefore: [],
    chainable: false,
  },

  grow_limb: {
    name: "grow_limb",
    purity: "non-idempotent-write",
    rollbackable: true,
    rollbackMethod: "uninstall-or-revert",
    idempotent: false,
    determinism: "non-deterministic",
    cacheability: false,
    freshnessTtlMs: 0,
    sourceVolatility: "static",
    inputArtifacts: [],
    outputArtifacts: [{ kind: "state-mutation", description: "新能力（依赖/工具链）" }],
    requiresNetwork: true,
    requiresUserFocus: false,
    requiresFileSystem: true,
    requiresBrowser: false,
    requiresDatabase: false,
    costClass: "moderate",
    typicalDurationMs: 30000,
    conflictKeys: ["limb-growth"],
    exclusiveResources: ["package-manager"],
    composableAfter: [],
    composableBefore: ["use_mastered_tool"],
    chainable: false,
  },

  auto_learn: {
    name: "auto_learn",
    purity: "non-idempotent-write",
    rollbackable: false,
    rollbackMethod: undefined,
    idempotent: false,
    determinism: "non-deterministic",
    cacheability: false,
    freshnessTtlMs: 0,
    sourceVolatility: "static",
    inputArtifacts: [],
    outputArtifacts: [{ kind: "state-mutation", description: "学习闭环结果" }],
    requiresNetwork: true,
    requiresUserFocus: false,
    requiresFileSystem: true,
    requiresBrowser: false,
    requiresDatabase: false,
    costClass: "expensive",
    typicalDurationMs: 60000,
    conflictKeys: ["learning-loop"],
    exclusiveResources: ["package-manager"],
    composableAfter: [],
    composableBefore: [],
    chainable: false,
  },

  evolve_self_code: {
    name: "evolve_self_code",
    purity: "non-idempotent-write",
    rollbackable: true,
    rollbackMethod: "git-revert-hook",
    idempotent: false,
    determinism: "non-deterministic",
    cacheability: false,
    freshnessTtlMs: 0,
    sourceVolatility: "static",
    inputArtifacts: [],
    outputArtifacts: [{ kind: "state-mutation", description: "决策钩子变更" }],
    requiresNetwork: false,
    requiresUserFocus: false,
    requiresFileSystem: true,
    requiresBrowser: false,
    requiresDatabase: false,
    costClass: "expensive",
    typicalDurationMs: 30000,
    conflictKeys: ["self-mutation"],
    exclusiveResources: ["self-mutation"],
    composableAfter: [],
    composableBefore: [],
    chainable: false,
  },
};

// ═══════════════════════════════════════════════════════════════════════
// execute_command 二次分类器
// ═══════════════════════════════════════════════════════════════════════

const SHELL_PATTERNS: Array<{ pattern: RegExp; category: ShellSubCategory; purity: Purity; cacheable: boolean }> = [
  // 纯读
  { pattern: /^(cat|head|tail|less|wc|grep|find|ls|pwd|which|file|stat|du|df) /, category: "shell-read", purity: "pure-read", cacheable: true },
  { pattern: /^echo /, category: "shell-read", purity: "pure-read", cacheable: true },
  // git 读
  { pattern: /^git (status|log|diff|show|branch|remote|tag)/, category: "shell-git", purity: "pure-read", cacheable: true },
  // git 写
  { pattern: /^git (add|commit|push|pull|merge|rebase|checkout|reset)/, category: "shell-git", purity: "non-idempotent-write", cacheable: false },
  // 网络
  { pattern: /^(curl|wget|ping|nslookup|dig|ssh|scp|nc) /, category: "shell-network", purity: "pure-read", cacheable: true },
  { pattern: /^(curl|wget).*(-X POST|-X PUT|-X DELETE|-d )/, category: "shell-network", purity: "non-idempotent-write", cacheable: false },
  // 包管理
  { pattern: /^(npm|yarn|pnpm|pip|brew|apt|cargo) (install|add|remove|uninstall)/, category: "shell-package", purity: "non-idempotent-write", cacheable: false },
  { pattern: /^(npm|yarn|pnpm|pip|brew|apt|cargo) (list|info|show|search)/, category: "shell-package", purity: "pure-read", cacheable: true },
  // 进程
  { pattern: /^(kill|pkill|killall|ps|top|htop|lsof|nohup) /, category: "shell-process", purity: "non-idempotent-write", cacheable: false },
  { pattern: /^ps /, category: "shell-process", purity: "pure-read", cacheable: false },
  // 文件写
  { pattern: /^(rm|mv|cp|mkdir|rmdir|chmod|chown|touch|tee|sed -i|truncate) /, category: "shell-write", purity: "non-idempotent-write", cacheable: false },
  { pattern: /[>|]/, category: "shell-write", purity: "non-idempotent-write", cacheable: false },
];

export function classifyShellCommand(cmd: string): { category: ShellSubCategory; purity: Purity; cacheable: boolean } {
  const trimmed = cmd.trim();
  for (const rule of SHELL_PATTERNS) {
    if (rule.pattern.test(trimmed)) {
      return { category: rule.category, purity: rule.purity, cacheable: rule.cacheable };
    }
  }
  return { category: "shell-unknown", purity: "non-idempotent-write", cacheable: false };
}

// ═══════════════════════════════════════════════════════════════════════
// 语义查询辅助
// ═══════════════════════════════════════════════════════════════════════

export function isPureRead(semantics: ToolSemantics): boolean {
  return semantics.purity === "pure-read";
}

export function isCacheable(semantics: ToolSemantics): boolean {
  return semantics.cacheability && semantics.freshnessTtlMs > 0;
}

export function canParallelWith(a: ToolSemantics, b: ToolSemantics): boolean {
  // 两个纯读操作永远可以并行
  if (isPureRead(a) && isPureRead(b)) return true;
  // 冲突键重叠 → 不能并行
  const aKeys = new Set(a.conflictKeys);
  for (const key of b.conflictKeys) {
    if (aKeys.has(key)) return false;
  }
  // 互斥资源重叠 → 不能并行
  const aExcl = new Set(a.exclusiveResources);
  for (const res of b.exclusiveResources) {
    if (aExcl.has(res)) return false;
  }
  // 有副作用的操作默认不与其他有副作用的操作并行
  if (!isPureRead(a) && !isPureRead(b)) return false;
  return true;
}

export function canChain(from: ToolSemantics, to: ToolSemantics): boolean {
  if (!from.chainable) return false;
  // 输出类型兼容检查
  const outputKinds = new Set(from.outputArtifacts.map(a => a.kind));
  const inputKinds = to.inputArtifacts.map(a => a.kind);
  // 至少一个输入类型匹配
  return inputKinds.length === 0 || inputKinds.some(k => outputKinds.has(k));
}
