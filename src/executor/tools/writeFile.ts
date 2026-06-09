/**
 * 内置工具 `write_file`（任务 11.10，R12.1 / R12.2 / R12.3 / R17.2）。
 *
 * 写/创建 sandbox 内的文件文本。`riskClass: "safe"`（写盘但限定在 sandbox 内，
 * 非删除/非命令，故默认安全；越界与符号链接逃逸由下述协作顺序拦截）。
 *
 * 协作顺序（安全关键，顺序不可调换，R12.2）：
 *   1. `SandboxGuard.isInside` 越界校验：目标解析 realpath 后越界 → 拒绝并记录 `blocked`。
 *   2. `detectSymlinkEscape`（内部 `lstat`）：目标若**已是符号链接**（无论指向何处）
 *      一律拒绝写入并记录 `blocked`——防止借既有软链把写入透传到 sandbox 外。
 *   3. 仅当前两步均通过，才实际写盘（必要时自动创建父目录）。
 *
 * 被拦截的结果以 `ToolResult{ ok:false, blocked:true }` 表达；其中 `blocked` 字段供执行
 * 循环据以记录"该次阻止"（R12.4）。相对路径相对 `ctx.workingDirRoot` 解析。
 *
 * _Requirements: 12.1, 12.3, 17.2_
 */

import fs from "node:fs/promises";
import path from "node:path";

import { detectSymlinkEscape } from "../symlinkEscape.js";
import type {
  Executor_Tool,
  ToolContext,
  ToolResult,
  ToolSpec,
} from "../types.js";

/** `write_file` 的 LLM 工具声明（JSON Schema 约束 `path` / `content`）。 */
const WRITE_FILE_SPEC: ToolSpec = {
  name: "write_file",
  description:
    "向 Working_Directory（sandbox）内的文件写入文本内容（覆盖式写入，文件不存在则创建，必要时创建父目录）。path 可为绝对路径或相对 sandbox 根的相对路径。",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "待写入文件的路径（绝对或相对 sandbox 根）。",
      },
      content: {
        type: "string",
        description: "要写入的完整文本内容。",
      },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
};

/**
 * 内置 `write_file` 工具实例。写盘前严格执行"越界校验 → 符号链接拒绝 → 写盘"顺序。
 */
export const writeFileTool: Executor_Tool = {
  name: "write_file",
  spec: WRITE_FILE_SPEC,
  riskClass: "safe",

  async invoke(
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const rawPath = args.path;
    if (typeof rawPath !== "string" || rawPath.trim().length === 0) {
      return { ok: false, output: "", error: "write_file 缺少有效的 path 参数" };
    }
    const content = typeof args.content === "string" ? args.content : "";

    const target = path.resolve(ctx.workingDirRoot, rawPath);

    // 1) 越界校验（realpath 解析后判定，R12.2 / R12.4）。
    if (!ctx.sandbox.isInside(target)) {
      return {
        ok: false,
        output: "",
        error: `越界拒绝: ${rawPath} 不在 Working_Directory 内`,
        blocked: true,
      };
    }

    // 2) 符号链接逃逸拦截：目标若已是符号链接一律拒绝写入并记录 blocked（R12.2）。
    //    复用共享的 detectSymlinkEscape：传入已解析为绝对路径的目标，内部 lstat 判定。
    const linkViolation = detectSymlinkEscape(
      { id: "write_file", name: "write_file", arguments: { path: target } },
      ctx.sandbox,
    );
    if (linkViolation) {
      return {
        ok: false,
        output: "",
        error: `符号链接逃逸已阻止: ${linkViolation}`,
        blocked: true,
      };
    }

    // 3) 实际写盘（必要时创建父目录）。
    try {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content, "utf8");
      return {
        ok: true,
        output: `已写入 ${rawPath}（${Buffer.byteLength(content, "utf8")} 字节）`,
      };
    } catch (err) {
      return {
        ok: false,
        output: "",
        error: `写入文件失败: ${(err as Error).message}`,
      };
    }
  },
};
