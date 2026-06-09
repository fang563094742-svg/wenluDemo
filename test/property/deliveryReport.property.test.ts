// Feature: proactive-awareness-demo, Property 20: For any 执行 log，产出的 Delivery_Report 对每个被修改的文件均含对应的 diff 条目，对每个所跑命令均含对应的命令输出条目（证据覆盖所有落地动作）。
//
// **Validates: Requirements 15.2**
//
// 被测：`src/delivery/deliveryVerifier.ts` 的 `DefaultDeliveryVerifier.buildReport` —— 它从
// 执行循环产物 `ExecutionResult.log` 派生交付证据：对每个被真实改动（write_file / delete_file，
// 已落地未被拦截）的文件给出一条 `fileDiffs`，对每条所跑命令（run_command，未被安全门拦截）给出
// 一条 `commandOutputs`，并据传入的 `acceptanceTestResults` 置
// `hasFailures = acceptanceTestResults.some(r => !r.passed)`。
//
// 本属性用 fast-check 生成包含 write_file / delete_file / run_command / 被拦截 / 执行失败 /
// 无关只读工具（read_file / list_dir）等各种形态的执行 log，与任意 acceptanceTestResults 组合，
// 断言 buildReport 产物的证据「1:1 覆盖」落地动作且 hasFailures 派生正确。
//
// 确定性与速度：buildReport 仅当存在 git/快照备份基准时才会调起 git diff 子进程；本测试一律传入
// `backup = undefined`，此时 computeFileDiff 走「无备份基准」分支返回纯字符串占位，全程无子进程、
// 无文件系统访问，结果完全确定且快速。workingDir 根仅参与 path.resolve/relative 的纯字符串运算，
// 取 os.tmpdir() 下一个固定名（不创建、不触碰任何真实文件）。

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import * as os from "node:os";
import * as path from "node:path";

import { DefaultDeliveryVerifier } from "../../src/delivery/deliveryVerifier.js";
import type { AcceptanceTestResult } from "../../src/delivery/decideAfterVerify.js";
import type { Task_Frame } from "../../src/clarifier/types.js";
import type { ExecutionResult, ToolInvocation } from "../../src/executor/types.js";
import type { WorkingDirectoryLike } from "../../src/executor/sandboxGuard.js";

// ---------------------------------------------------------------------------
// 固定夹具：被测实例、最小 Task_Frame、纯字符串运算用的工作目录根
// ---------------------------------------------------------------------------

const verifier = new DefaultDeliveryVerifier();

/** buildReport 只读取 taskFrame.objective（用于 summary 文本），其余字段给最小合法值即可。 */
function makeTaskFrame(): Task_Frame {
  return {
    awarenessItemId: "item-prop20",
    objective: "为交付报告证据完整性属性测试构造的任务",
    phases: [],
    resolvedPreconditions: [],
    confidence: { basedOnUserInput: [], basedOnDefaultAssumption: [] },
    acceptanceTests: [],
  };
}

// 仅参与 path.resolve / path.relative 的纯字符串运算（backup=undefined 时不触盘）。
const workingDir: WorkingDirectoryLike = {
  rootAbsPath: path.join(os.tmpdir(), "pad-delivery-report-prop20"),
};

// ---------------------------------------------------------------------------
// 生成器：各种形态的单步工具调用记录（ToolInvocation）
// ---------------------------------------------------------------------------

// 受限文件路径池（含重复可能，用以覆盖「同一文件被多次改动只产生一条 diff」的去重语义）。
const FILE_PATHS = ["src/a.ts", "src/b.ts", "lib/util.js", "docs/readme.md", "src/nested/c.tsx"];
// 受限命令池。
const COMMANDS = ["npm test", "npm run build", "ls -la", "node script.js", "echo hi"];

const outputArb = fc.string();

/** write_file / delete_file 记录：path 可能为有效路径 / 空串 / 缺失，ok 与 blocked 任意。 */
const writeOrDeleteInvArb: fc.Arbitrary<ToolInvocation> = fc
  .record({
    name: fc.constantFrom("write_file", "delete_file"),
    // 8:1:1 倾向有效路径，同时覆盖空串与缺失（typeof !== "string" / length === 0 应被排除）。
    pathChoice: fc.oneof(
      { weight: 8, arbitrary: fc.constantFrom(...FILE_PATHS) },
      { weight: 1, arbitrary: fc.constant("") },
      { weight: 1, arbitrary: fc.constant(undefined) },
    ),
    ok: fc.boolean(),
    blocked: fc.boolean(),
    output: outputArb,
  })
  .map(({ name, pathChoice, ok, blocked, output }) => ({
    tc: { name, arguments: { path: pathChoice } },
    result: { ok, output, blocked },
    blocked,
  }));

/** run_command 记录：command 取自命令池，ok 与 blocked 任意。 */
const runCommandInvArb: fc.Arbitrary<ToolInvocation> = fc
  .record({
    command: fc.constantFrom(...COMMANDS),
    ok: fc.boolean(),
    blocked: fc.boolean(),
    output: outputArb,
  })
  .map(({ command, ok, blocked, output }) => ({
    tc: { name: "run_command", arguments: { command } },
    result: { ok, output, blocked },
    blocked,
  }));

/** 无关只读工具记录（read_file / list_dir）：既不算改动文件也不算所跑命令，应被完全忽略。 */
const otherInvArb: fc.Arbitrary<ToolInvocation> = fc
  .record({
    name: fc.constantFrom("read_file", "list_dir"),
    p: fc.constantFrom(...FILE_PATHS),
    ok: fc.boolean(),
    output: outputArb,
  })
  .map(({ name, p, ok, output }) => ({
    tc: { name, arguments: { path: p } },
    result: { ok, output },
  }));

const invocationArb = fc.oneof(writeOrDeleteInvArb, runCommandInvArb, otherInvArb);

const execResultArb: fc.Arbitrary<ExecutionResult> = fc.record({
  status: fc.constantFrom<ExecutionResult["status"]>("completed", "max_steps_reached", "aborted"),
  log: fc.array(invocationArb, { maxLength: 24 }),
});

/** 单条验收测试结果；passed 任意，其余字段任意。 */
const acceptanceResultArb: fc.Arbitrary<AcceptanceTestResult> = fc.record({
  testId: fc.string(),
  description: fc.string(),
  checkMethod: fc.string(),
  passed: fc.boolean(),
  detail: fc.string(),
});
const acceptanceResultsArb = fc.array(acceptanceResultArb, { maxLength: 8 });

// ---------------------------------------------------------------------------
// 参考口径（oracle）：从执行 log 直接推导「落地动作」集合
// ---------------------------------------------------------------------------

/** 被真实改动的文件路径（write/delete，未被拦截且 ok，path 为非空字符串），保序去重。 */
function landedModifiedPaths(log: ToolInvocation[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const inv of log) {
    if (inv.blocked || !inv.result.ok) continue;
    if (inv.tc.name !== "write_file" && inv.tc.name !== "delete_file") continue;
    const p = inv.tc.arguments.path;
    if (typeof p !== "string" || p.length === 0) continue;
    if (!seen.has(p)) {
      seen.add(p);
      ordered.push(p);
    }
  }
  return ordered;
}

/** 所跑命令（run_command，未被拦截）的 {command, output}，保序、不去重（每次调用一条）。 */
function ranCommands(log: ToolInvocation[]): { command: string; output: string }[] {
  const out: { command: string; output: string }[] = [];
  for (const inv of log) {
    if (inv.tc.name !== "run_command" || inv.blocked) continue;
    out.push({
      command: String(inv.tc.arguments.command ?? ""),
      output: inv.result.output ?? "",
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Property 20
// ---------------------------------------------------------------------------

describe("Property 20: Delivery_Report 证据完整性", () => {
  it("每个被改动文件有且仅有一条对应 fileDiffs 条目（证据 1:1 覆盖，无遗漏无冗余，diff 非空）", async () => {
    await fc.assert(
      fc.asyncProperty(execResultArb, acceptanceResultsArb, async (execResult, accResults) => {
        const report = await verifier.buildReport(
          makeTaskFrame(),
          workingDir,
          undefined,
          execResult,
          accResults,
        );

        const landed = landedModifiedPaths(execResult.log);
        const reportPaths = report.fileDiffs.map((d) => d.path);

        // 数量 1:1：fileDiffs 条目数恰等于去重后的被改动文件数（无冗余条目）。
        expect(report.fileDiffs.length).toBe(landed.length);
        // 集合一一对应：每个被改动文件都有对应 diff 条目，且不含任何额外路径。
        expect(new Set(reportPaths)).toEqual(new Set(landed));
        // fileDiffs 自身无重复路径（同一文件多次改动只出一条）。
        expect(new Set(reportPaths).size).toBe(reportPaths.length);
        // 每条 diff 都是非空证据字符串。
        for (const d of report.fileDiffs) {
          expect(typeof d.diff).toBe("string");
          expect(d.diff.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("每条所跑命令有对应 commandOutputs 条目（按序 1:1，命令与输出原样保留）", async () => {
    await fc.assert(
      fc.asyncProperty(execResultArb, acceptanceResultsArb, async (execResult, accResults) => {
        const report = await verifier.buildReport(
          makeTaskFrame(),
          workingDir,
          undefined,
          execResult,
          accResults,
        );

        const expected = ranCommands(execResult.log);
        // 数量 1:1，且按执行顺序逐条命令/输出原样覆盖。
        expect(report.commandOutputs).toEqual(expected);
      }),
      { numRuns: 100 },
    );
  });

  it("被安全门拦截或执行失败的写/删，以及被拦截的命令，绝不出现在证据中（负向覆盖）", async () => {
    const BLOCKED_PATH = "__sentinel_blocked__.ts";
    const FAILED_PATH = "__sentinel_failed__.ts";
    const BLOCKED_CMD = "__sentinel_blocked_command__";

    await fc.assert(
      fc.asyncProperty(execResultArb, acceptanceResultsArb, async (execResult, accResults) => {
        // 注入：被拦截的写、执行失败的写、被拦截的命令（均不应产生任何证据条目）。
        const injected: ToolInvocation[] = [
          {
            tc: { name: "write_file", arguments: { path: BLOCKED_PATH } },
            result: { ok: true, output: "", blocked: true },
            blocked: true,
          },
          {
            tc: { name: "delete_file", arguments: { path: FAILED_PATH } },
            result: { ok: false, output: "", error: "执行失败" },
          },
          {
            tc: { name: "run_command", arguments: { command: BLOCKED_CMD } },
            result: { ok: false, output: "", blocked: true },
            blocked: true,
          },
        ];
        const log = [...execResult.log, ...injected];
        const report = await verifier.buildReport(
          makeTaskFrame(),
          workingDir,
          undefined,
          { ...execResult, log },
          accResults,
        );

        const reportPaths = report.fileDiffs.map((d) => d.path);
        expect(reportPaths).not.toContain(BLOCKED_PATH);
        expect(reportPaths).not.toContain(FAILED_PATH);
        expect(report.commandOutputs.some((c) => c.command === BLOCKED_CMD)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it("hasFailures = acceptanceTestResults.some(r => !r.passed)（派生正确）", async () => {
    await fc.assert(
      fc.asyncProperty(execResultArb, acceptanceResultsArb, async (execResult, accResults) => {
        const report = await verifier.buildReport(
          makeTaskFrame(),
          workingDir,
          undefined,
          execResult,
          accResults,
        );

        expect(report.hasFailures).toBe(accResults.some((r) => !r.passed));
        // 验收结果集合原样回填到报告（证据完整性的一部分）。
        expect(report.acceptanceTestResults).toEqual(accResults);
      }),
      { numRuns: 100 },
    );
  });
});
