/**
 * demoFullPipeline.ts — 问路全链路 CLI 演示。
 *
 * 展示从 Task_Frame 出发的完整流水线：
 *   tools 加载 → context 编译 → 并发调度执行 → 验收验证 → 元反思
 *
 * 使用 mock LLM + mock FS 避免真实外部依赖，同时演示各层的真实协作。
 *
 * 运行:
 *   node --import tsx/esm scripts/demoFullPipeline.ts          # 正常流程
 *   node --import tsx/esm scripts/demoFullPipeline.ts --fail   # 模拟部分写入遗漏，触发元反思
 */

const SIMULATE_FAIL = process.argv.includes("--fail");

import type {
  Task_Frame,
  Acceptance_Test,
  LogicalPhase,
  Execution_Precondition,
} from "../src/clarifier/types.js";
import { createConcurrentScheduler } from "../src/runtime/concurrentScheduler.js";
import type {
  ToolCall,
  ToolResult,
  ToolInvoker,
  SchedulerEvent,
  SemanticRegistry,
  ConflictDetector,
} from "../src/runtime/concurrentScheduler.js";
import { createToolCache } from "../src/tools/cachePolicy.js";
import { createBudgetGovernor } from "../src/runtime/budgetGovernor.js";
import { TOOL_SEMANTICS } from "../src/tools/toolSemantics.js";
import type { ToolSemantics } from "../src/tools/toolSemantics.js";
import { buildInitialContext } from "../src/executor/executor.js";

// ═══════════════════════════════════════════════════════════════════════
// 1. Mock Task_Frame（模拟澄清器产出）
// ═══════════════════════════════════════════════════════════════════════

const SAMPLE_TASK: Task_Frame = {
  awarenessItemId: "demo-rename-task",
  objective: "将 src/utils/format.ts 中 getUserName 重命名为 getUsername，并同步更新所有调用方",
  phases: [
    { id: "p1", order: 1, title: "搜索所有引用", status: "saturated" },
    { id: "p2", order: 2, title: "批量重命名", status: "saturated" },
    { id: "p3", order: 3, title: "运行类型检查确认无遗漏", status: "pending" },
  ],
  resolvedPreconditions: [
    {
      id: "pc-1",
      phaseId: "p2",
      description: "是否保留旧函数导出作为过渡",
      status: "known" as const,
      risk_level: "low" as const,
      related_action: "删除旧导出",
      resolvedBy: "user_input",
      resolvedValue: "否，直接删除旧导出",
    },
  ],
  confidence: {
    basedOnUserInput: [{ precondition: "是否保留旧函数导出", value: "否" }],
    basedOnDefaultAssumption: [],
  },
  primaryTargets: [
    "src/utils/format.ts",
    "src/components/UserCard.tsx",
    "src/api/handlers/user.ts",
  ],
  acceptanceTests: [
    {
      id: "AT-1",
      description: "getUserName 不再存在于代码库中（grep 验证）",
      checkMethod: "run_command: grep -rn getUserName src/ 返回空",
    },
    {
      id: "AT-2",
      description: "TypeScript 编译通过",
      checkMethod: "run_command: tsc --noEmit 退出码 0",
    },
    {
      id: "AT-3",
      description: "getUsername 在 format.ts 中正确导出",
      checkMethod: "read_file: src/utils/format.ts 包含 export function getUsername",
    },
  ],
};

// ═══════════════════════════════════════════════════════════════════════
// 2. 基础设施：语义注册、冲突检测、工具调用器
// ═══════════════════════════════════════════════════════════════════════

function makeSemanticRegistry(): SemanticRegistry {
  return {
    get(toolName: string): ToolSemantics | undefined {
      return TOOL_SEMANTICS[toolName];
    },
  };
}

function makeConflictDetector(): ConflictDetector {
  return {
    maxParallelSet(toolNames: string[]): string[][] {
      const reads: string[] = [];
      const writes: string[] = [];
      for (const name of toolNames) {
        const sem = TOOL_SEMANTICS[name];
        if (sem && sem.purity !== "pure-read") {
          writes.push(name);
        } else {
          reads.push(name);
        }
      }
      const groups: string[][] = [];
      if (reads.length > 0) groups.push(reads);
      for (const w of writes) groups.push([w]);
      return groups;
    },
  };
}

/**
 * Mock invoker: 模拟文件系统的工具执行器。
 * - read_file: 返回预置文件内容
 * - write_file: 记录写入
 * - run_command: 模拟命令输出
 */
function makeMockInvoker() {
  const fileSystem = new Map<string, string>([
    ["src/utils/format.ts", [
      'export function getUserName(id: string): string {',
      '  return `user_${id}`;',
      '}',
    ].join("\n")],
    ["src/components/UserCard.tsx", [
      'import { getUserName } from "../utils/format";',
      'export const UserCard = ({ id }: { id: string }) => {',
      '  const name = getUserName(id);',
      '  return <div>{name}</div>;',
      '};',
    ].join("\n")],
    ["src/api/handlers/user.ts", [
      'import { getUserName } from "../../utils/format";',
      'export function handleUser(id: string) { return getUserName(id); }',
    ].join("\n")],
  ]);

  const writeLog: Array<{ path: string; content: string }> = [];
  let commandLog: string[] = [];

  const invoker: ToolInvoker = async (
    toolName: string,
    params: Record<string, unknown>,
    _signal: AbortSignal,
  ): Promise<unknown> => {
    await new Promise((r) => setTimeout(r, 20 + Math.random() * 30));

    if (toolName === "read_file") {
      const path = params.path as string;
      const content = fileSystem.get(path);
      if (!content) return { ok: false, error: `文件不存在: ${path}` };
      return { ok: true, output: content };
    }

    if (toolName === "write_file") {
      const path = params.path as string;
      const content = params.content as string;
      fileSystem.set(path, content);
      writeLog.push({ path, content });
      return { ok: true, output: `已写入 ${path}` };
    }

    if (toolName === "run_command") {
      const cmd = params.command as string;
      commandLog.push(cmd);
      if (cmd.includes("grep") && cmd.includes("getUserName")) {
        const hasOld = [...fileSystem.values()].some(v => v.includes("getUserName"));
        if (hasOld) return { ok: true, output: "src/utils/format.ts:1:getUserName" };
        return { ok: true, output: "" };
      }
      if (cmd.includes("tsc")) {
        return { ok: true, output: "" };
      }
      return { ok: true, output: `(mock) ${cmd}` };
    }

    if (toolName === "list_dir") {
      return { ok: true, output: [...fileSystem.keys()].join("\n") };
    }

    return { ok: false, error: `未知工具: ${toolName}` };
  };

  return { invoker, fileSystem, writeLog, commandLog };
}

// ═══════════════════════════════════════════════════════════════════════
// 3. 验收验证器（模拟 verifier 层对 acceptance tests 逐条检查）
// ═══════════════════════════════════════════════════════════════════════

interface VerificationResult {
  testId: string;
  pass: boolean;
  detail: string;
}

async function runAcceptanceTests(
  tests: Acceptance_Test[],
  invoker: ToolInvoker,
  signal: AbortSignal,
): Promise<VerificationResult[]> {
  const results: VerificationResult[] = [];

  for (const test of tests) {
    if (test.checkMethod.startsWith("run_command:")) {
      const cmd = test.checkMethod.replace("run_command:", "").trim();
      const expectEmpty = cmd.includes("返回空");
      const actualCmd = cmd.split(" 返回")[0].split(" 退出码")[0].trim();
      const result = (await invoker("run_command", { command: actualCmd }, signal)) as any;

      if (expectEmpty) {
        const pass = result.ok && (result.output === "" || result.output?.trim() === "");
        results.push({ testId: test.id, pass, detail: pass ? "grep 结果为空" : `仍有匹配: ${result.output}` });
      } else {
        results.push({ testId: test.id, pass: result.ok, detail: result.ok ? "命令成功" : result.error });
      }
    } else if (test.checkMethod.startsWith("read_file:")) {
      const parts = test.checkMethod.replace("read_file:", "").trim();
      const [filePath, ...rest] = parts.split(" 包含 ");
      const expected = rest.join(" 包含 ");
      const result = (await invoker("read_file", { path: filePath.trim() }, signal)) as any;
      const pass = result.ok && result.output?.includes(expected);
      results.push({ testId: test.id, pass, detail: pass ? `包含 "${expected}"` : `未找到 "${expected}"` });
    } else {
      results.push({ testId: test.id, pass: false, detail: `不支持的检查方式: ${test.checkMethod}` });
    }
  }

  return results;
}

// ═══════════════════════════════════════════════════════════════════════
// 4. 元反思层（模拟，对失败 test 生成修复建议）
// ═══════════════════════════════════════════════════════════════════════

interface ReflectionInsight {
  testId: string;
  diagnosis: string;
  suggestion: string;
}

function metaReflect(results: VerificationResult[]): ReflectionInsight[] {
  const failures = results.filter((r) => !r.pass);
  if (failures.length === 0) return [];

  return failures.map((f) => ({
    testId: f.testId,
    diagnosis: `验收测试 ${f.testId} 未通过: ${f.detail}`,
    suggestion: f.detail.includes("仍有匹配")
      ? "需要继续搜索并替换剩余的旧名称引用"
      : f.detail.includes("未找到")
        ? "写入的文件内容不符合预期，需重新检查 write_file 参数"
        : "需排查具体失败原因后重试",
  }));
}

// ═══════════════════════════════════════════════════════════════════════
// 5. 模拟 LLM 决策：产出 tool calls 序列
// ═══════════════════════════════════════════════════════════════════════

function simulateLLMToolCallSequence(): ToolCall[][] {
  const round1: ToolCall[] = [
    { id: "tc-1", toolName: "read_file", params: { path: "src/utils/format.ts" } },
    { id: "tc-2", toolName: "read_file", params: { path: "src/components/UserCard.tsx" } },
    { id: "tc-3", toolName: "read_file", params: { path: "src/api/handlers/user.ts" } },
  ];

  const round2: ToolCall[] = SIMULATE_FAIL
    ? [
        // 故意遗漏 format.ts 的写入 → 验收测试 AT-3 将失败
        { id: "tc-5", toolName: "write_file", params: {
          path: "src/components/UserCard.tsx",
          content: [
            'import { getUsername } from "../utils/format";',
            'export const UserCard = ({ id }: { id: string }) => {',
            '  const name = getUsername(id);',
            '  return <div>{name}</div>;',
            '};',
          ].join("\n"),
        }},
        { id: "tc-6", toolName: "write_file", params: {
          path: "src/api/handlers/user.ts",
          content: 'import { getUsername } from "../../utils/format";\nexport function handleUser(id: string) { return getUsername(id); }',
        }},
      ]
    : [
        { id: "tc-4", toolName: "write_file", params: {
          path: "src/utils/format.ts",
          content: 'export function getUsername(id: string): string {\n  return `user_${id}`;\n}',
        }},
        { id: "tc-5", toolName: "write_file", params: {
          path: "src/components/UserCard.tsx",
          content: [
            'import { getUsername } from "../utils/format";',
            'export const UserCard = ({ id }: { id: string }) => {',
            '  const name = getUsername(id);',
            '  return <div>{name}</div>;',
            '};',
          ].join("\n"),
        }},
        { id: "tc-6", toolName: "write_file", params: {
          path: "src/api/handlers/user.ts",
          content: 'import { getUsername } from "../../utils/format";\nexport function handleUser(id: string) { return getUsername(id); }',
        }},
      ];

  const round3: ToolCall[] = [
    { id: "tc-7", toolName: "run_command", params: { command: "grep -rn getUserName src/" } },
    { id: "tc-8", toolName: "run_command", params: { command: "tsc --noEmit" } },
  ];

  return [round1, round2, round3];
}

// ═══════════════════════════════════════════════════════════════════════
// Main Pipeline
// ═══════════════════════════════════════════════════════════════════════

async function main() {
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║    问路（Wenlu）全链路 Pipeline 演示                    ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
  if (SIMULATE_FAIL) {
    console.log("  [--fail 模式] 模拟 write 遗漏，触发验收失败 + 元反思\n");
  } else {
    console.log("")
  }

  // ── Step 1: Context Compilation ──
  console.log("━━━ Step 1: Context 编译（Task_Frame → 初始上下文） ━━━\n");
  const initialContext = buildInitialContext(SAMPLE_TASK);
  const contextPreview = (initialContext[0].content as string).split("\n").slice(0, 8).join("\n");
  console.log(contextPreview);
  console.log("  ...(共", (initialContext[0].content as string).split("\n").length, "行)\n");

  // ── Step 2: Scheduler Setup ──
  console.log("━━━ Step 2: 并发调度器初始化 ━━━\n");
  const events: SchedulerEvent[] = [];
  const scheduler = createConcurrentScheduler({
    conflictDetector: makeConflictDetector(),
    budgetGovernor: createBudgetGovernor(),
    cache: createToolCache(100),
    semantics: makeSemanticRegistry(),
    eventBus: { emit(ev) { events.push(ev); } },
  });
  console.log("  调度器就绪 (缓存容量=100, 预算=默认)");

  // ── Step 3: Execute tool call rounds ──
  console.log("\n━━━ Step 3: 执行 tool-calling 循环（3 rounds） ━━━\n");
  const { invoker, fileSystem, writeLog } = makeMockInvoker();
  const rounds = simulateLLMToolCallSequence();

  for (let i = 0; i < rounds.length; i++) {
    const calls = rounds[i];
    const toolNames = calls.map(c => c.toolName);
    console.log(`  Round ${i + 1}: [${toolNames.join(", ")}]`);

    const results = await scheduler.dispatch(calls, invoker);

    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      const status = r.success ? "OK" : "FAIL";
      const raw = r.output;
      const outputStr = typeof raw === "object" && raw !== null
        ? (raw as any).output ?? (raw as any).error ?? JSON.stringify(raw)
        : String(raw ?? "");
      const preview = String(outputStr).slice(0, 60).replace(/\n/g, "\\n");
      const arg = (calls[j].params as any).path ?? (calls[j].params as any).command ?? "";
      console.log(`    [${status}] ${calls[j].toolName}(${arg}) → ${preview || "(empty)"}`);
    }
  }

  const stats = scheduler.stats;
  console.log(`\n  调度统计: dispatched=${stats.totalDispatched}, cacheHits=${stats.totalCacheHits}`);
  console.log(`  事件总数: ${events.length}`);
  console.log(`  文件写入: ${writeLog.length} 次`);

  // ── Step 4: Acceptance Test Verification ──
  console.log("\n━━━ Step 4: 验收测试（Acceptance Tests） ━━━\n");
  const signal = new AbortController().signal;
  const verifyResults = await runAcceptanceTests(SAMPLE_TASK.acceptanceTests, invoker, signal);

  let allPass = true;
  for (const vr of verifyResults) {
    const icon = vr.pass ? "✓" : "✗";
    console.log(`  [${icon}] ${vr.testId}: ${vr.detail}`);
    if (!vr.pass) allPass = false;
  }

  // ── Step 5: Meta-Reflection ──
  console.log("\n━━━ Step 5: 元反思（Meta-Reflection） ━━━\n");
  const insights = metaReflect(verifyResults);
  if (insights.length === 0) {
    console.log("  全部验收通过，无需反思修复。");
  } else {
    for (const ins of insights) {
      console.log(`  [${ins.testId}] ${ins.diagnosis}`);
      console.log(`    建议: ${ins.suggestion}`);
    }
  }

  // ── Summary ──
  console.log("\n━━━ 流水线总结 ━━━\n");
  console.log(`  任务: ${SAMPLE_TASK.objective}`);
  console.log(`  执行 rounds: ${rounds.length}`);
  console.log(`  工具调用总数: ${rounds.reduce((s, r) => s + r.length, 0)}`);
  console.log(`  验收测试: ${verifyResults.filter(r => r.pass).length}/${verifyResults.length} 通过`);
  console.log(`  最终状态: ${allPass ? "delivered ✓" : "needs_retry (元反思已给出修复建议)"}`);
  console.log("");
}

main().catch((e) => {
  console.error("Pipeline demo failed:", e);
  process.exit(1);
});
