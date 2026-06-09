// Feature: proactive-awareness-demo, Property 19: *For any* 工具执行中产生的错误，若为非阻断性（小问题）则 `askUser` 不被调用、结果回灌后循环继续；若为阻断性问题则进入 `blocked_on_user` 并调用 `askUser` 暂停，等待用户答复后回灌继续。
//
// **Validates: Requirements 14.1, 14.2**
//
// 被测编排单元：`runLoop` 的「执行中问题处理分流」分支（任务 11.11，R14.1/R14.2）。
// 策略：用一个**会抛错的 mock 工具**（probe_tool）触发执行中错误，错误种类由 fast-check
// 生成并按构造语义直接给出期望分流（expectedBlocking），不复用被测 `isBlocking` 做 oracle。
//   - 阻断性（→ true）：`BlockingError` 实例、或带 `blocking === true` 标记的 Error。
//   - 非阻断性（→ false）：普通 Error、或带 `blocking === false` 标记的 Error。
// mock LLM：第 1 次返回对 probe_tool 的 tool call（必触发抛错分流），第 2 次返回 finalText，
// 借 `maxSteps=2` 干净收敛。mock LLM 在每次被调用时快照其收到的 `messages`，据此校验：
//   - 两种分流下错误结果都被回灌（tool 角色消息，error 等于抛出的 message）；
//   - 阻断性时 `askUser` 恰被调用一次、用户答复以 user 角色消息回灌；
//   - 非阻断性时 `askUser` 绝不被调用、无该答复回灌；
//   - 两种分流下循环都继续（completeWithTools 被第二次调用）。
// probe_tool 既非 delete_file/run_command、参数不含 path，故不触发高危门/越界门/符号链接门，
// 分流逻辑可被确定性观测。

import os from "node:os";
import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { BlockingError, runLoop } from "../../src/executor/executor.js";
import type { Task_Frame } from "../../src/clarifier/types.js";
import type {
  LLM_Provider,
  LlmMessage,
  LlmToolRequest,
  LlmToolResponse,
} from "../../src/llm/llmProvider.js";
import type {
  ExecutionHooks,
  ExecutionProgressEvent,
  Executor_Tool,
  ToolResult,
} from "../../src/executor/types.js";

// ---------------------------------------------------------------------------
// 固定常量与最小任务
// ---------------------------------------------------------------------------

/** 触发抛错的工具调用 id（用于校验结果是否按此 id 回灌为 tool 角色消息）。 */
const PROBE_CALL_ID = "call-0";

/** sandbox 根：用系统临时目录（真实存在，满足 SandboxGuard 的 realpathSync 规范化）。 */
const WD = { rootAbsPath: os.tmpdir() };

/** 最小可执行任务（buildInitialContext 仅读取这些字段；primaryTargets 留空不影响分流校验）。 */
const TASK: Task_Frame = {
  awarenessItemId: "ai-1",
  objective: "触发执行中错误以验证分流",
  phases: [],
  resolvedPreconditions: [],
  confidence: { basedOnUserInput: [], basedOnDefaultAssumption: [] },
  acceptanceTests: [
    { id: "at-1", description: "占位验收", checkMethod: "exit code == 0" },
  ],
  primaryTargets: [],
};

// ---------------------------------------------------------------------------
// 错误种类 → 按构造已知的期望分流
// ---------------------------------------------------------------------------

type ErrorKind = "blockingError" | "blockingFlag" | "plainError" | "flagFalse";

/** 按错误种类构造抛错器；全部为 Error 子类/实例，故 `err.message` 在回灌中被保留。 */
function makeThrower(kind: ErrorKind, msg: string): () => never {
  switch (kind) {
    case "blockingError":
      return () => {
        throw new BlockingError(msg);
      };
    case "blockingFlag":
      return () => {
        const e = new Error(msg);
        (e as { blocking?: boolean }).blocking = true;
        throw e;
      };
    case "plainError":
      return () => {
        throw new Error(msg);
      };
    case "flagFalse":
      return () => {
        const e = new Error(msg);
        (e as { blocking?: boolean }).blocking = false;
        throw e;
      };
  }
}

/** 由构造语义直接给出期望：仅 BlockingError / blocking===true 视为阻断性。 */
function expectBlocking(kind: ErrorKind): boolean {
  return kind === "blockingError" || kind === "blockingFlag";
}

// ---------------------------------------------------------------------------
// 生成器
// ---------------------------------------------------------------------------

const kindArb = fc.constantFrom<ErrorKind>(
  "blockingError",
  "blockingFlag",
  "plainError",
  "flagFalse",
);
const msgArb = fc.string({ minLength: 1, maxLength: 40 });
const answerArb = fc.string({ minLength: 1, maxLength: 40 });

// ---------------------------------------------------------------------------
// 一次执行循环：装配 mock 工具 / mock LLM / hooks，运行 runLoop，回收观测量
// ---------------------------------------------------------------------------

interface RunObservations {
  /** completeWithTools 被调用次数（>= 2 表示循环在错误后继续）。 */
  llmCallCount: number;
  /** 每次 completeWithTools 收到的 messages 快照（按调用顺序）。 */
  messagesAtCall: LlmMessage[][];
  /** askUser 收到的问题文案（按调用顺序）。 */
  askUserCalls: string[];
  /** confirmHighRisk 是否被误触发（probe_tool 非高危，应恒为 0）。 */
  confirmCount: number;
}

async function runOnce(kind: ErrorKind, msg: string, answer: string): Promise<RunObservations> {
  const thrower = makeThrower(kind, msg);

  // 会抛错的 mock 工具：非 delete_file/run_command、riskClass safe、参数不含 path，
  // 故绕过高危门/越界门/符号链接门，直达 invoke 抛错分流。
  const probeTool: Executor_Tool = {
    name: "probe_tool",
    riskClass: "safe",
    spec: {
      name: "probe_tool",
      description: "测试用：执行即抛出受控错误以验证分流",
      parameters: { type: "object", properties: {} },
    },
    invoke: async (): Promise<ToolResult> => {
      return thrower();
    },
  };

  const obs: RunObservations = {
    llmCallCount: 0,
    messagesAtCall: [],
    askUserCalls: [],
    confirmCount: 0,
  };

  const llm: LLM_Provider = {
    providerKey: "mock",
    complete: () => {
      throw new Error("Property 19 测试不应触达 complete。");
    },
    completeWithTools: async (req: LlmToolRequest): Promise<LlmToolResponse> => {
      // 快照本次收到的 messages（消息对象创建后不再被修改，浅拷贝数组即足够）。
      obs.messagesAtCall.push(req.messages.map((m) => ({ ...m })));
      const idx = obs.llmCallCount;
      obs.llmCallCount += 1;
      if (idx === 0) {
        // 第 1 次：发起对 probe_tool 的调用（必触发抛错分流）。
        return { toolCalls: [{ id: PROBE_CALL_ID, name: "probe_tool", arguments: {} }] };
      }
      // 第 2 次起：返回 finalText（无 tool calls），配合 maxSteps=2 干净收敛。
      return { finalText: "完成（测试收敛）" };
    },
  };

  const hooks: ExecutionHooks = {
    confirmHighRisk: async () => {
      obs.confirmCount += 1;
      return "confirm";
    },
    askUser: async (problem: string): Promise<string> => {
      obs.askUserCalls.push(problem);
      return answer;
    },
    emitProgress: (_event: ExecutionProgressEvent): void => {
      /* no-op：本属性不校验事件流 */
    },
  };

  await runLoop(TASK, WD, hooks, { llm, tools: [probeTool], maxSteps: 2 });
  return obs;
}

// ---------------------------------------------------------------------------
// 属性
// ---------------------------------------------------------------------------

describe("Property 19: 执行中问题处理分流", () => {
  it("非阻断小问题不调用 askUser、结果回灌后继续；阻断性问题调用 askUser 暂停并回灌答复", async () => {
    await fc.assert(
      fc.asyncProperty(kindArb, msgArb, answerArb, async (kind, msg, answer) => {
        const obs = await runOnce(kind, msg, answer);
        const blocking = expectBlocking(kind);

        // 公共：probe_tool 非高危，高危确认门绝不被触发。
        expect(obs.confirmCount).toBe(0);

        // 公共：循环在错误处理后继续（completeWithTools 第二次被调用）。
        expect(obs.llmCallCount).toBe(2);
        expect(obs.messagesAtCall.length).toBe(2);

        // 公共：错误结果以 tool 角色消息按 call id 回灌，且 error 等于抛出的 message。
        const second = obs.messagesAtCall[1];
        const toolMsg = second.find(
          (m) => m.role === "tool" && m.toolCallId === PROBE_CALL_ID,
        );
        expect(toolMsg).toBeDefined();
        const parsed = JSON.parse(toolMsg!.content) as ToolResult;
        expect(parsed.ok).toBe(false);
        expect(parsed.error).toBe(msg);

        // 是否存在「用户答复」回灌（user 角色消息内容等于 askUser 的返回）。
        const answerFedBack = second.some(
          (m) => m.role === "user" && m.content === answer,
        );

        if (blocking) {
          // 阻断性：askUser 恰一次，问题文案含抛出的 message；答复被回灌继续。
          expect(obs.askUserCalls.length).toBe(1);
          expect(obs.askUserCalls[0]).toContain(msg);
          expect(answerFedBack).toBe(true);
        } else {
          // 非阻断小问题：askUser 绝不被调用，亦无答复回灌。
          expect(obs.askUserCalls.length).toBe(0);
          expect(answerFedBack).toBe(false);
        }
        return true;
      }),
      { numRuns: 100 },
    );
  });
});
