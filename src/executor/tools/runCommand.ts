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

function resolveShell(): { command: string; args: string[] } {
  if (process.platform === "win32") {
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"],
    };
  }
  return {
    command: "/bin/sh",
    args: ["-lc"],
  };
}

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

      if (!ctx.sandbox.isInside(ctx.workingDirRoot)) {
        return Promise.resolve({
          ok: false,
          output: "",
          error: `越界拒绝: 工作目录 ${ctx.workingDirRoot} 不在 Working_Directory 内`,
          blocked: true,
        });
      }

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

      return new Promise<ToolResult>((resolve) => {
        const shell = resolveShell();
        const child = spawn(shell.command, [...shell.args, command], {
          cwd: ctx.workingDirRoot,
          shell: false,
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

        child.on("error", (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({
            ok: false,
            output: summarize(stdout, stderr, `进程启动失败: ${err.message}`),
            error: `运行命令失败: ${err.message}`,
          });
        });

        child.on("close", (code, signal) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);

          if (timedOut) {
            resolve({
              ok: false,
              output: summarize(stdout, stderr, `命令执行超时（>${timeoutMs}ms）`),
              error: `命令执行超时（>${timeoutMs}ms）`,
            });
            return;
          }

          if (code === 0) {
            resolve({
              ok: true,
              output: summarize(stdout, stderr, "exit_code: 0"),
            });
            return;
          }

          const exitInfo = signal
            ? `exit_signal: ${signal}`
            : `exit_code: ${code ?? "unknown"}`;
          resolve({
            ok: false,
            output: summarize(stdout, stderr, exitInfo),
            error: `命令执行失败（${exitInfo}）`,
          });
        });
      });
    },
  };
}

export const runCommandTool = createRunCommandTool();
