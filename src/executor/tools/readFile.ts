/**
 * 内置工具 `read_file`（任务 11.10，R12.1 / R12.3 / R17.2）。
 *
 * 读取 sandbox 内的文件文本。`riskClass: "safe"`（只读，不改变文件系统状态）。
 *
 * 安全自校验（防御性纵深，R12.2 / R12.4）：即便执行循环已在调用前做过 sandbox 越界
 * 校验，工具内部仍用注入的 `ctx.sandbox` 对目标路径**再次**做 `isInside` 校验——越界
 * 则拒绝读取并以 `ToolResult{ ok:false }` 回灌（不抛异常崩溃循环）。
 *
 * 相对路径一律相对 `ctx.workingDirRoot`（sandbox 根）解析。文件不存在 / 不可读 / 实为
 * 目录等，均作为**可回灌的非致命错误**返回 `ok:false`，由执行循环回灌给 LLM 自行调整。
 *
 * _Requirements: 12.1, 12.3, 17.2_
 */

import fs from "node:fs/promises";
import path from "node:path";

import type {
  Executor_Tool,
  ToolContext,
  ToolResult,
  ToolSpec,
} from "../types.js";

/** `read_file` 的 LLM 工具声明（JSON Schema 约束 `path` 参数）。 */
const READ_FILE_SPEC: ToolSpec = {
  name: "read_file",
  description:
    "读取 Working_Directory（sandbox）内某个文件的文本内容。path 可为绝对路径或相对 sandbox 根的相对路径。",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "待读取文件的路径（绝对或相对 sandbox 根）。",
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
};

/**
 * 内置 `read_file` 工具实例。读取 sandbox 内文件并以文本回灌。
 */
export const readFileTool: Executor_Tool = {
  name: "read_file",
  spec: READ_FILE_SPEC,
  riskClass: "safe",

  async invoke(
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const rawPath = args.path;
    if (typeof rawPath !== "string" || rawPath.trim().length === 0) {
      return { ok: false, output: "", error: "read_file 缺少有效的 path 参数" };
    }

    const target = path.resolve(ctx.workingDirRoot, rawPath);

    // 防御性纵深：工具内对目标路径再次做 sandbox 越界自校验（R12.2 / R12.4）。
    if (!ctx.sandbox.isInside(target)) {
      return {
        ok: false,
        output: "",
        error: `越界拒绝: ${rawPath} 不在 Working_Directory 内`,
      };
    }

    try {
      const content = await fs.readFile(target, "utf8");
      return { ok: true, output: content };
    } catch (err) {
      return {
        ok: false,
        output: "",
        error: `读取文件失败: ${(err as Error).message}`,
      };
    }
  },
};
