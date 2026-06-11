/**
 * verificationEngine.ts — 结构化验证引擎。
 *
 * 替代 riverMain 中的单条 verifyCmd + 退出码判断。
 *
 * 能力：
 * 1. 多断言并行执行（互不阻塞的断言并行跑）
 * 2. hard-gate 失败立即短路（blocking 断言）
 * 3. 多探测源：shell / http / file / state / browser / db
 * 4. 证据结构化采集，喂给 actionLedger
 * 5. 部分成功判定（soft-score）
 * 6. 向后兼容：单条 verifyCmd 退化为单 shell 断言
 */

import { exec } from "child_process";
import { access, readFile } from "fs/promises";
import type { Assertion, AssertionResult, CollectedEvidence, VerificationResult, AssertionContext } from "./assertionTypes.js";

// ═══════════════════════════════════════════════════════════════════════
// 引擎接口
// ═══════════════════════════════════════════════════════════════════════

export interface VerificationEngine {
  verify(taskId: string, assertions: Assertion[], context: AssertionContext): Promise<VerificationResult>;
  verifyLegacy(taskId: string, verifyCmd: string, timeoutMs?: number): Promise<VerificationResult>;
}

/**
 * 可注入的宿主 shell 执行器（迁移用）：把 shell 类断言/verifyCmd 的执行落到
 * 「当前用户自己的电脑」（经连接器）。返回 null 表示不接管 → 回退引擎默认服务端 exec。
 */
export type HostShellExec = (
  cmd: string,
  cwd: string | undefined,
  timeoutMs: number,
) => Promise<{ stdout: string; stderr: string; code: number | null } | null>;

// ═══════════════════════════════════════════════════════════════════════
// 单条断言执行器
// ═══════════════════════════════════════════════════════════════════════

async function executeShellProbe(assertion: Assertion, context: AssertionContext, shellExec?: HostShellExec): Promise<AssertionResult> {
  const start = Date.now();
  if (!assertion.cmd) {
    return failResult(assertion, start, "missing cmd for shell probe");
  }

  // 迁移点：注入的宿主执行器（连接器在线 → 在用户本机执行）。返回 null 表示不接管 →
  // 回退下方默认的服务端 exec（离线时行为与改造前逐字一致）。
  if (shellExec) {
    try {
      const hosted = await shellExec(assertion.cmd, context.workingDir, assertion.timeoutMs);
      if (hosted) {
        const durationMs = Date.now() - start;
        const evidence = buildEvidence(assertion, hosted.stdout, hosted.stderr, hosted.code);
        const passed = evaluateExpect(assertion, hosted.code, hosted.stdout);
        return {
          id: assertion.id,
          description: assertion.description,
          severity: assertion.severity,
          passed,
          durationMs,
          evidence,
        };
      }
    } catch (err: any) {
      return failResult(assertion, start, err?.message ?? String(err));
    }
  }

  return new Promise<AssertionResult>((resolve) => {
    const child = exec(assertion.cmd!, { cwd: context.workingDir, timeout: assertion.timeoutMs });
    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (d) => { stdout += d; });
    child.stderr?.on("data", (d) => { stderr += d; });

    child.on("close", (code) => {
      const durationMs = Date.now() - start;
      const evidence = buildEvidence(assertion, stdout, stderr, code);
      const passed = evaluateExpect(assertion, code, stdout);
      resolve({
        id: assertion.id,
        description: assertion.description,
        severity: assertion.severity,
        passed,
        durationMs,
        evidence,
      });
    });

    child.on("error", (err) => {
      resolve(failResult(assertion, start, err.message));
    });

    setTimeout(() => {
      child.kill("SIGKILL");
    }, assertion.timeoutMs + 1000);
  });
}

async function executeHttpProbe(assertion: Assertion, _context: AssertionContext): Promise<AssertionResult> {
  const start = Date.now();
  if (!assertion.httpUrl) {
    return failResult(assertion, start, "missing httpUrl for http probe");
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), assertion.timeoutMs);

    const response = await fetch(assertion.httpUrl, {
      method: assertion.httpMethod ?? "GET",
      headers: assertion.httpHeaders,
      signal: controller.signal,
    });
    clearTimeout(timeout);

    const durationMs = Date.now() - start;
    const body = await response.text();
    const truncatedBody = body.slice(0, 10240);

    let passed = true;
    const checks: string[] = [];

    if (assertion.httpExpectStatus !== undefined) {
      const statusOk = response.status === assertion.httpExpectStatus;
      if (!statusOk) checks.push(`status ${response.status} != ${assertion.httpExpectStatus}`);
      passed = passed && statusOk;
    }

    if (assertion.httpExpectBodyContains) {
      const bodyOk = body.includes(assertion.httpExpectBodyContains);
      if (!bodyOk) checks.push(`body missing: "${assertion.httpExpectBodyContains}"`);
      passed = passed && bodyOk;
    }

    if (assertion.httpMaxResponseTimeMs !== undefined) {
      const timeOk = durationMs <= assertion.httpMaxResponseTimeMs;
      if (!timeOk) checks.push(`response ${durationMs}ms > max ${assertion.httpMaxResponseTimeMs}ms`);
      passed = passed && timeOk;
    }

    return {
      id: assertion.id,
      description: assertion.description,
      severity: assertion.severity,
      passed,
      durationMs,
      evidence: {
        type: "http-response",
        raw: truncatedBody,
        summary: `${response.status} ${response.statusText} (${durationMs}ms)${checks.length ? " — " + checks.join("; ") : ""}`,
        timestamp: new Date().toISOString(),
        metadata: { status: response.status, headers: Object.fromEntries(response.headers.entries()) },
      },
    };
  } catch (err: any) {
    return failResult(assertion, start, err.message);
  }
}

async function executeFileProbe(assertion: Assertion, _context: AssertionContext): Promise<AssertionResult> {
  const start = Date.now();
  if (!assertion.filePath) {
    return failResult(assertion, start, "missing filePath for file probe");
  }

  try {
    if (assertion.expect === "file-not-exists") {
      try {
        await access(assertion.filePath);
        return {
          id: assertion.id,
          description: assertion.description,
          severity: assertion.severity,
          passed: false,
          durationMs: Date.now() - start,
          evidence: { type: "file-content", raw: "", summary: "file exists but expected not-exists", timestamp: new Date().toISOString() },
        };
      } catch {
        return {
          id: assertion.id,
          description: assertion.description,
          severity: assertion.severity,
          passed: true,
          durationMs: Date.now() - start,
          evidence: { type: "file-content", raw: "", summary: "file does not exist (expected)", timestamp: new Date().toISOString() },
        };
      }
    }

    // file-exists / file-contains / file-matches
    await access(assertion.filePath);
    if (assertion.expect === "file-exists") {
      return {
        id: assertion.id,
        description: assertion.description,
        severity: assertion.severity,
        passed: true,
        durationMs: Date.now() - start,
        evidence: { type: "file-content", raw: "", summary: "file exists", timestamp: new Date().toISOString() },
      };
    }

    const content = await readFile(assertion.filePath, "utf-8");
    const truncated = content.slice(0, 10240);

    if (assertion.expect === "file-contains" && assertion.fileExpectContains) {
      const passed = content.includes(assertion.fileExpectContains);
      return {
        id: assertion.id,
        description: assertion.description,
        severity: assertion.severity,
        passed,
        durationMs: Date.now() - start,
        evidence: { type: "file-content", raw: truncated, summary: passed ? "contains expected string" : "missing expected string", timestamp: new Date().toISOString() },
      };
    }

    if (assertion.expect === "file-matches" && assertion.fileExpectMatches) {
      const passed = new RegExp(assertion.fileExpectMatches).test(content);
      return {
        id: assertion.id,
        description: assertion.description,
        severity: assertion.severity,
        passed,
        durationMs: Date.now() - start,
        evidence: { type: "file-content", raw: truncated, summary: passed ? "matches regex" : "regex not matched", timestamp: new Date().toISOString() },
      };
    }

    return failResult(assertion, start, "unsupported file expect type");
  } catch (err: any) {
    if (assertion.expect === "file-exists") {
      return {
        id: assertion.id,
        description: assertion.description,
        severity: assertion.severity,
        passed: false,
        durationMs: Date.now() - start,
        evidence: { type: "file-content", raw: "", summary: `file not accessible: ${err.message}`, timestamp: new Date().toISOString() },
      };
    }
    return failResult(assertion, start, err.message);
  }
}

async function executeStateProbe(assertion: Assertion, context: AssertionContext): Promise<AssertionResult> {
  const start = Date.now();
  if (!assertion.stateField) {
    return failResult(assertion, start, "missing stateField for state probe");
  }

  try {
    const value = getNestedField(context.stateSnapshot, assertion.stateField);
    let passed: boolean;

    if (assertion.expect === "state-field-exists") {
      passed = value !== undefined && value !== null;
    } else if (assertion.expect === "state-field-equals") {
      passed = JSON.stringify(value) === JSON.stringify(assertion.stateExpectValue);
    } else {
      passed = value !== undefined;
    }

    return {
      id: assertion.id,
      description: assertion.description,
      severity: assertion.severity,
      passed,
      durationMs: Date.now() - start,
      evidence: {
        type: "state-snapshot",
        raw: JSON.stringify(value, null, 2)?.slice(0, 2048) ?? "undefined",
        summary: `${assertion.stateField} = ${JSON.stringify(value)?.slice(0, 100)}`,
        timestamp: new Date().toISOString(),
      },
    };
  } catch (err: any) {
    return failResult(assertion, start, err.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 辅助函数
// ═══════════════════════════════════════════════════════════════════════

function evaluateExpect(assertion: Assertion, exitCode: number | null, stdout: string): boolean {
  const expect = assertion.expect ?? "exit-zero";
  const expectValue = assertion.expectValue;

  switch (expect) {
    case "exit-zero":
      return exitCode === 0;
    case "exit-nonzero":
      return exitCode !== 0;
    case "stdout-contains":
      return typeof expectValue === "string" && stdout.includes(expectValue);
    case "stdout-not-contains":
      return typeof expectValue === "string" && !stdout.includes(expectValue);
    case "stdout-matches":
      return typeof expectValue === "string" && new RegExp(expectValue).test(stdout);
    case "stdout-json-path":
      try {
        const obj = JSON.parse(stdout);
        const path = typeof expectValue === "string" ? expectValue : "";
        return getNestedField(obj, path) !== undefined;
      } catch {
        return false;
      }
    default:
      return exitCode === 0;
  }
}

function buildEvidence(assertion: Assertion, stdout: string, stderr: string, exitCode: number | null): CollectedEvidence {
  return {
    type: assertion.evidenceType,
    raw: (stdout + (stderr ? "\n---STDERR---\n" + stderr : "")).slice(0, 10240),
    summary: `exit=${exitCode}${stdout.length > 100 ? ` stdout=${stdout.length}b` : ""}`,
    timestamp: new Date().toISOString(),
    metadata: { exitCode, stdoutLen: stdout.length, stderrLen: stderr.length },
  };
}

function failResult(assertion: Assertion, startTime: number, error: string): AssertionResult {
  return {
    id: assertion.id,
    description: assertion.description,
    severity: assertion.severity,
    passed: false,
    durationMs: Date.now() - startTime,
    evidence: { type: assertion.evidenceType, raw: "", summary: `ERROR: ${error}`, timestamp: new Date().toISOString() },
    error,
  };
}

function getNestedField(obj: unknown, path: string): unknown {
  const parts = path.split(".");
  let current: any = obj;
  for (const part of parts) {
    if (current == null) return undefined;
    current = current[part];
  }
  return current;
}

// ═══════════════════════════════════════════════════════════════════════
// 引擎实现
// ═══════════════════════════════════════════════════════════════════════

export function createVerificationEngine(opts: { shellExec?: HostShellExec } = {}): VerificationEngine {
  const shellExec = opts.shellExec;
  async function executeAssertion(assertion: Assertion, context: AssertionContext): Promise<AssertionResult> {
    switch (assertion.probeType) {
      case "shell":
        return executeShellProbe(assertion, context, shellExec);
      case "http":
        return executeHttpProbe(assertion, context);
      case "file":
        return executeFileProbe(assertion, context);
      case "state":
        return executeStateProbe(assertion, context);
      default:
        return failResult(assertion, Date.now(), `unsupported probe type: ${assertion.probeType}`);
    }
  }

  async function verify(taskId: string, assertions: Assertion[], context: AssertionContext): Promise<VerificationResult> {
    const start = Date.now();
    const results: AssertionResult[] = [];
    let shortCircuited = false;

    // 分组：blocking 的串行执行，non-blocking 的可以并行
    const blocking = assertions.filter(a => a.blocking);
    const nonBlocking = assertions.filter(a => !a.blocking);

    // 先跑 blocking 断言（串行）
    for (const assertion of blocking) {
      const result = await executeAssertion(assertion, context);
      results.push(result);
      if (!result.passed && assertion.severity === "hard-gate") {
        shortCircuited = true;
        break;
      }
    }

    // 如果 blocking 全通过，并行跑 non-blocking 断言
    if (!shortCircuited && nonBlocking.length > 0) {
      const parallelResults = await Promise.all(
        nonBlocking.map(a => executeAssertion(a, context))
      );
      results.push(...parallelResults);
    }

    // 计算 verdict
    const hardGates = results.filter(r => r.severity === "hard-gate");
    const softSignals = results.filter(r => r.severity === "soft-signal");
    const hardGatesPassed = hardGates.every(r => r.passed);
    const softPassedCount = softSignals.filter(r => r.passed).length;
    const softScore = softSignals.length > 0 ? softPassedCount / softSignals.length : 1;

    let overallVerdict: "passed" | "failed" | "partial";
    if (!hardGatesPassed) {
      overallVerdict = "failed";
    } else if (softScore < 1) {
      overallVerdict = "partial";
    } else {
      overallVerdict = "passed";
    }

    const totalDurationMs = Date.now() - start;
    const passedCount = results.filter(r => r.passed).length;
    const summary = `${passedCount}/${results.length} assertions passed (hard-gates: ${hardGatesPassed ? "ALL OK" : "FAILED"}, soft-score: ${(softScore * 100).toFixed(0)}%)`;

    return {
      taskId,
      timestamp: new Date().toISOString(),
      assertions: results,
      overallVerdict,
      hardGatesPassed,
      softScore,
      totalDurationMs,
      summary,
    };
  }

  async function verifyLegacy(taskId: string, verifyCmd: string, timeoutMs: number = 10000): Promise<VerificationResult> {
    const assertion: Assertion = {
      id: "legacy-verify",
      description: `legacy verifyCmd: ${verifyCmd.slice(0, 80)}`,
      severity: "hard-gate",
      probeType: "shell",
      timeoutMs,
      blocking: true,
      cmd: verifyCmd,
      expect: "exit-zero",
      evidenceType: "stdout",
    };
    return verify(taskId, [assertion], { taskId, stateSnapshot: null, workingDir: process.cwd() });
  }

  return { verify, verifyLegacy };
}
