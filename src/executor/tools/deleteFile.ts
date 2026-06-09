/**
 * 内置工具 `delete_file`（任务 11.10，R12.1 / R12.3 / R17.2）。
 *
 * 删除 sandbox 内的文件。`riskClass: "conditional"`——`High_Risk_Guard` 将 `delete_file`
 * **始终**判为 High_Risk_Action（恒走弹窗确认），故本工具被实际 invoke 时意味着用户已
 * 确认放行；本工具自身不再做高危确认（那是执行循环的职责）。
 *
 * 安全自校验（防御性纵深，R12.2 / R12.4）：用注入的 `ctx.sandbox` 对目标路径做
 * `isInside` 越界校验——越界则拒绝并以 `ToolResult{ ok:false, blocked:true }` 记录。
 * 为防止"借符号链接删到 sandbox 外的真实文件"，目标若**本身是符号链接**则用
 * `unlink` 仅删除链接本身（不跟随）；目标为目录则递归删除。
 *
 * 相对路径相对 `ctx.workingDirRoot` 解析。文件不存在等作为可回灌的非致命错误返回 `ok:false`。
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

/** `delete_file` 的 LLM 工具声明（JSON Schema 约束 `path`）。 */
const DELETE_FILE_SPEC: ToolSpec = {
  name: "delete_file",
  description:
    "删除 Working_Directory（sandbox）内的文件或目录（高危动作，执行前需用户确认）。path 可为绝对或相对 sandbox 根的相对路径。",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "待删除的文件或目录路径（绝对或相对 sandbox 根）。",
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
};

/**
 * 内置 `delete_file` 工具实例。恒高危（由 High_Risk_Guard 确认），删除前做 sandbox 自校验。
 */
export const deleteFileTool: Executor_Tool = {
  name: "delete_file",
  spec: DELETE_FILE_SPEC,
  riskClass: "conditional",

  async invoke(
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const rawPath = args.path;
    if (typeof rawPath !== "string" || rawPath.trim().length === 0) {
      return { ok: false, output: "", error: "delete_file 缺少有效的 path 参数" };
    }

    const target = path.resolve(ctx.workingDirRoot, rawPath);

    // 防御性纵深：目标路径 sandbox 越界自校验（R12.2 / R12.4）。
    if (!ctx.sandbox.isInside(target)) {
      return {
        ok: false,
        output: "",
        error: `越界拒绝: ${rawPath} 不在 Working_Directory 内`,
        blocked: true,
      };
    }

    try {
      // 用 lstat（不跟随符号链接）判定类型：软链仅删链接本身，避免删到 sandbox 外真实文件。
      const stat = await fs.lstat(target);
      if (stat.isDirectory()) {
        await fs.rm(target, { recursive: true, force: false });
      } else {
        await fs.unlink(target);
      }
      return { ok: true, output: `已删除 ${rawPath}` };
    } catch (err) {
      return {
        ok: false,
        output: "",
        error: `删除失败: ${(err as Error).message}`,
      };
    }
  },
};
