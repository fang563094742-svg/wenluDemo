/**
 * assertionTypes.ts — 断言类型定义。
 *
 * 支持多维度验证：不再只有"退出码 0/非0"。
 * 关键设计点：
 * - hard-gate vs soft-signal 严格区分
 * - 断言源不限于 shell——支持 http/browser/db/file/state probe
 * - 证据结构化采集（不是只留 pass/fail）
 */

// ═══════════════════════════════════════════════════════════════════════
// 断言严重度
// ═══════════════════════════════════════════════════════════════════════

export type AssertionSeverity = "hard-gate" | "soft-signal";

// ═══════════════════════════════════════════════════════════════════════
// 断言探测源类型
// ═══════════════════════════════════════════════════════════════════════

export type ProbeType = "shell" | "http" | "file" | "state" | "db" | "browser";

// ═══════════════════════════════════════════════════════════════════════
// 断言期望匹配方式
// ═══════════════════════════════════════════════════════════════════════

export type ExpectType =
  | "exit-zero"              // shell 退出码为 0
  | "exit-nonzero"           // shell 退出码非 0
  | "stdout-contains"        // stdout 包含字符串
  | "stdout-not-contains"    // stdout 不包含字符串
  | "stdout-matches"         // stdout 匹配正则
  | "stdout-json-path"       // stdout 是 JSON，某 path 满足条件
  | "file-exists"            // 文件存在
  | "file-not-exists"        // 文件不存在
  | "file-contains"          // 文件内容包含
  | "file-matches"           // 文件内容匹配正则
  | "http-status"            // HTTP 状态码等于
  | "http-body-contains"     // HTTP 响应体包含
  | "http-response-time"     // HTTP 响应时间小于
  | "state-field-equals"     // agentState 某字段等于
  | "state-field-exists"     // agentState 某字段存在
  | "custom"                 // 自定义函数判断

// ═══════════════════════════════════════════════════════════════════════
// 单条断言定义
// ═══════════════════════════════════════════════════════════════════════

export interface Assertion {
  id: string;
  description: string;
  severity: AssertionSeverity;
  probeType: ProbeType;
  timeoutMs: number;
  blocking: boolean;         // blocking=true 时，此断言失败则跳过后续断言

  // === Shell probe ===
  cmd?: string;
  expect?: ExpectType;
  expectValue?: string | number | boolean;

  // === HTTP probe ===
  httpUrl?: string;
  httpMethod?: string;
  httpHeaders?: Record<string, string>;
  httpExpectStatus?: number;
  httpExpectBodyContains?: string;
  httpMaxResponseTimeMs?: number;

  // === File probe ===
  filePath?: string;
  fileExpectContains?: string;
  fileExpectMatches?: string;  // 正则

  // === State probe ===
  stateField?: string;  // dot-path (如 "evolution.capabilities.length")
  stateExpectValue?: unknown;

  // === Custom probe ===
  customFn?: (context: AssertionContext) => Promise<boolean>;

  // === 证据类型 ===
  evidenceType: EvidenceType;
}

export type EvidenceType =
  | "stdout"
  | "stderr"
  | "exit-code"
  | "http-response"
  | "file-diff"
  | "file-content"
  | "state-snapshot"
  | "timing"
  | "custom";

export interface AssertionContext {
  taskId: string;
  stateSnapshot: unknown;
  workingDir: string;
}

// ═══════════════════════════════════════════════════════════════════════
// 断言执行结果
// ═══════════════════════════════════════════════════════════════════════

export interface AssertionResult {
  id: string;
  description: string;
  severity: AssertionSeverity;
  passed: boolean;
  durationMs: number;
  evidence: CollectedEvidence;
  error?: string;
}

export interface CollectedEvidence {
  type: EvidenceType;
  raw: string;            // 原始输出（截断至 10KB）
  summary?: string;       // 人类可读摘要
  timestamp: string;
  metadata?: Record<string, unknown>;
}

// ═══════════════════════════════════════════════════════════════════════
// 整体验证结果
// ═══════════════════════════════════════════════════════════════════════

export interface VerificationResult {
  taskId: string;
  timestamp: string;
  assertions: AssertionResult[];
  overallVerdict: "passed" | "failed" | "partial";
  hardGatesPassed: boolean;
  softScore: number;         // 0-1
  totalDurationMs: number;
  summary: string;           // 人类可读总结
}

// ═══════════════════════════════════════════════════════════════════════
// 便捷构造器
// ═══════════════════════════════════════════════════════════════════════

let assertionCounter = 0;

export function shellAssertion(opts: {
  description: string;
  cmd: string;
  expect?: ExpectType;
  expectValue?: string | number;
  severity?: AssertionSeverity;
  timeoutMs?: number;
}): Assertion {
  return {
    id: `assert-${++assertionCounter}`,
    description: opts.description,
    severity: opts.severity ?? "hard-gate",
    probeType: "shell",
    timeoutMs: opts.timeoutMs ?? 10000,
    blocking: opts.severity === "hard-gate" || opts.severity === undefined,
    cmd: opts.cmd,
    expect: opts.expect ?? "exit-zero",
    expectValue: opts.expectValue,
    evidenceType: "stdout",
  };
}

export function httpAssertion(opts: {
  description: string;
  url: string;
  method?: string;
  expectStatus?: number;
  expectBodyContains?: string;
  maxResponseTimeMs?: number;
  severity?: AssertionSeverity;
  timeoutMs?: number;
}): Assertion {
  return {
    id: `assert-${++assertionCounter}`,
    description: opts.description,
    severity: opts.severity ?? "hard-gate",
    probeType: "http",
    timeoutMs: opts.timeoutMs ?? 15000,
    blocking: false,
    httpUrl: opts.url,
    httpMethod: opts.method ?? "GET",
    httpExpectStatus: opts.expectStatus ?? 200,
    httpExpectBodyContains: opts.expectBodyContains,
    httpMaxResponseTimeMs: opts.maxResponseTimeMs,
    evidenceType: "http-response",
  };
}

export function fileAssertion(opts: {
  description: string;
  path: string;
  exists?: boolean;
  contains?: string;
  matches?: string;
  severity?: AssertionSeverity;
}): Assertion {
  return {
    id: `assert-${++assertionCounter}`,
    description: opts.description,
    severity: opts.severity ?? "hard-gate",
    probeType: "file",
    timeoutMs: 5000,
    blocking: false,
    filePath: opts.path,
    expect: opts.exists === false ? "file-not-exists" : opts.contains ? "file-contains" : opts.matches ? "file-matches" : "file-exists",
    expectValue: opts.contains ?? opts.matches,
    fileExpectContains: opts.contains,
    fileExpectMatches: opts.matches,
    evidenceType: "file-content",
  };
}

export function stateAssertion(opts: {
  description: string;
  field: string;
  expectValue?: unknown;
  severity?: AssertionSeverity;
}): Assertion {
  return {
    id: `assert-${++assertionCounter}`,
    description: opts.description,
    severity: opts.severity ?? "soft-signal",
    probeType: "state",
    timeoutMs: 1000,
    blocking: false,
    stateField: opts.field,
    stateExpectValue: opts.expectValue,
    expect: opts.expectValue !== undefined ? "state-field-equals" : "state-field-exists",
    evidenceType: "state-snapshot",
  };
}
