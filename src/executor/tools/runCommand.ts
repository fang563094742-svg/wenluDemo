/**
 * 内置工具 `run_command`（任务 11.10，R12.1 / R12.2 / R12.3 / R17.2）。
 *
 * 在 sandbox 内（cwd = Working_Directory 根）执行 shell 命令。`riskClass: "conditional"`
 * ——是否高危由 `High_Risk_Guard` 据命令串判定（黑名单 + 白名单兜底），本工具自身不做
 * 高危确认（那是执行循环的职责）；但本工具承担两道与命令直接相关的安全闸：
 *
 *   1. **执行前符号链接逃逸检测**（R12.2）：对命令串做 `detectSymlinkEscape`，若命令含
 *      `ln -s <src> <linkName>` 且软链落点在 sandbox 内、源指向 sandbox 外 → 阻止执行并
 *      以 `ToolResult{ ok:false, blocked:true }` 记录（防止凭空造一条逃逸软链）。
 *   2. **执行超时**（对抗性审查后新增）：对子进程施加 `RUN_COMMAND_TIMEOUT_MS`（默认 60s，
 *      可配置）超时。超时到达即**终止子进程**并返回 `ToolResult{ ok:false }`（可回灌的
 *      非致命错误，由执行循环计为 `failed`），防止 `sleep`/死循环挂死整个执行循环。
 *
 * cwd 强制为 sandbox 根并经 `isInside` 自校验（R12.2 / R12.4）。命令非零退出作为可回灌的
 * 非致命错误返回 `ok:false`（含 stdout/stderr 摘要），由执行循环回灌给 LLM 自行调整。
 *
 * _Requirements: 12.1, 12.3, 17.2_
 */

import { spawn } from "node:child_process";

import { RUN_COMMAND_TIMEOUT_MS } from "../../config/config.js";
import { detectSymlinkEscape } from "../symlinkEscape.js";
import type {
  Executor_Tool,
  ToolContext,
  ToolResult,
  ToolSpec,
} from "../types.js";

/** `run_command` 的 LLM 工具声明（JSON Schema 约束 `command`）。 */
const RUN_COMMAND_SPEC: ToolSpec = {
  name: "run_command",
  description:
    "在 Working_Directory（sandbox）内执行一条 shell 命令（工作目录固定为 sandbox 根，受执行超时与高危确认约束）。返回 stdout/stderr 及退出码摘要。",
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "要执行的 shell 命令串。",
      },
    },
    required: ["command"],
    additionalProperties: false,
  },
};

/**
 * 拼接 stdout/stderr 与退出信息为可回灌摘要。
 */
function summarize(
  stdout: string,
  stderr: string,
  exitInfo: string,
): string {
  const parts: string[] = [];
  if (stdout.length > 0) parts.push(`stdout:\n${stdout}`);
  if (stderr.length > 0) parts.push(`stderr:\n${stderr}`);
  parts.push(exitInfo);
  return parts.join("\n");
}

/**
 * 内置 `run_command` 工具实例。执行前做符号链接逃逸检测，执行时施加超时。
 *
 * @param timeoutMs 执行超时（毫秒），默认 `RUN_COMMAND_TIMEOUT_MS`，便于测试注入更短超时。
 */
export function createRunCommandTool(
  timeoutMs: number = RUN_COMMAND_TIMEOUT_MS,
): Executor_Tool {
  return {
    name: "run_command",
    spec: RUN_COMMAND_SPEC,
    riskClass: "conditional",

    invoke(
      args: Record<string, unknown>,
      ctx: ToolContext,
    ): Promise<ToolResult> {
      const command = args.command;
      if (typeof command !== "string" || command.trim().length === 0) {
        return Promise.resolve({
          ok: false,
          output: "",
          error: "run_command 缺少有效的 command 参数",
        });
      }

      // 防御性纵深：cwd（sandbox 根）越界自校验（R12.2 / R12.4）。
      if (!ctx.sandbox.isInside(ctx.workingDirRoot)) {
        return Promise.resolve({
          ok: false,
          output: "",
          error: `越界拒绝: 工作目录 ${ctx.workingDirRoot} 不在 Working_Directory 内`,
          blocked: true,
        });
      }

      // 1) 符号链接逃逸检测：命令含越界 `ln -s` → 阻止并记录 blocked（R12.2）。
      const linkViolation = detectSymlinkEscape(
        { id: "run_command", name: "run_command", arguments: { command } },
        ctx.sandbox,
      );
      if (linkViolation) {
        return Promise.resolve({
          ok: false,
          output: "",
          error: `符号链接逃逸已阻止: ${linkViolation}`,
          blocked: true,
        });
      }

      // 2) 执行（cwd = sandbox 根），施加超时；超时即终止子进程（可回灌的非致命错误）。
      return new Promise<ToolResult>((resolve) => {
        const child = spawn(command, {
          cwd: ctx.workingDirRoot,
          shell: true,
        });

        let stdout = "";
        let stderr = "";
        let timedOut = false;
        let settled = false;

        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, timeoutMs);

        child.stdout?.on("data", (chunk: Buffer) => {
          stdout += chunk.toString();
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
        });

        const finish = (result: ToolResult): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(result);
        };

        child.on("error", (err) => {
          finish({
            ok: false,
            output: summarize(stdout, stderr, ""),
            error: `命令启动失败: ${err.message}`,
          });
        });

        child.on("close", (code, signal) => {
          if (timedOut) {
            finish({
              ok: false,
              output: summarize(stdout, stderr, `已超时终止（信号 ${signal ?? "SIGKILL"}）`),
              error: `命令执行超时（>${timeoutMs}ms），已终止子进程`,
            });
            return;
          }
          if (code === 0) {
            finish({
              ok: true,
              output: summarize(stdout, stderr, "退出码 0"),
            });
            return;
          }
          finish({
            ok: false,
            output: summarize(stdout, stderr, `退出码 ${code ?? "null"}（信号 ${signal ?? "无"}）`),
            error: `命令以非零退出码 ${code ?? "null"} 结束`,
          });
        });
      });
    },
  };
}

/**
 * 内置 `run_command` 工具实例（使用默认超时 `RUN_COMMAND_TIMEOUT_MS`）。
 */
export const runCommandTool: Executor_Tool = createRunCommandTool();
