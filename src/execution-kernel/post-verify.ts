/**
 * 持续执行内核 · 动作后独立验证（post-verify.ts）
 * ------------------------------------------------------------------
 * 把"执行≠成功"落到具体动作上：对有副作用的工具，在执行之后用独立手段判定意图
 * 是否真达成（文件真存在？进程真停了？内容真写对了？），而非只看结果字符串。
 *
 * 库内只做"判定"与"策略表"两件纯逻辑：
 *  - VERIFY_POLICY：哪些工具需要 post-verify（always / on-side-effect / never）。
 *  - judgePostVerify：给定 {工具名, 参数, 真实回读证据}，判定 passed + 证据 + 原因。
 * 真实回读（fs.existsSync / safeExec 探进程）由接线点注入 evidence，库不绑定 IO，保独立性。
 *
 * failedAttempts 防重复犯错：shouldForceNewApproach 判定同一动作连续失败是否该换方案。
 * _Requirements: 1.2, 1.3, 1.5, 1.8_
 */

export type VerifyPolicy = "always" | "on-side-effect" | "never";

/** 工具验证策略表：mastered tool 最易"假成功"，故 always。只读类 never。 */
export const VERIFY_POLICY: Readonly<Record<string, VerifyPolicy>> = {
  execute_command: "on-side-effect",
  write_file: "always",
  patch_file: "always",
  delete_file: "always",
  focus_native_app: "never", // 已内置前后快照验证
  read_file: "never",
  list_directory: "never",
  inspect_native_apps: "never",
  web_search: "never",
  browse_url: "never",
  use_mastered_tool: "always",
};

/** 是否需要对该工具做 post-verify（结合命令是否有副作用）。 */
export function needsPostVerify(toolName: string, hasSideEffect: boolean): boolean {
  const policy = VERIFY_POLICY[toolName];
  if (policy === "always") return true;
  if (policy === "never" || policy === undefined) return false;
  // on-side-effect
  return hasSideEffect;
}

/** execute_command 是否有写副作用（重定向 / 删除 / kill 等）。 */
export function commandHasSideEffect(command: string): boolean {
  if (!command) return false;
  return /(^|[^>])>>?\s|\brm\b|\bmv\b|\bcp\b|\bmkdir\b|\btouch\b|\bkill\b|\bpkill\b|\bstop\b/.test(command);
}

export interface PostVerifyEvidence {
  /** 接线点注入的真实回读：目标是否存在 / 进程是否仍在 / 回读内容片段。 */
  targetExists?: boolean;
  processStillRunning?: boolean;
  readbackContent?: string;
  sizeBytes?: number;
}

export interface PostVerifyResult {
  passed: boolean;
  evidence: string;
  reason?: string;
}

/**
 * 纯判定：依据工具语义 + 注入的真实回读证据，判定意图是否达成。
 * 证据缺失（接线点没注入）⟹ passed=true 但标注未验证（fail-open，不阻断）。
 */
export function judgePostVerify(params: {
  toolName: string;
  args: Record<string, unknown>;
  evidence?: PostVerifyEvidence;
}): PostVerifyResult {
  const { toolName, args, evidence } = params;
  if (!evidence) return { passed: true, evidence: "no evidence injected; not verified" };

  switch (toolName) {
    case "write_file":
    case "patch_file": {
      if (evidence.targetExists === false) {
        return { passed: false, evidence: "", reason: "文件写入后不存在" };
      }
      const expected = String(args.content ?? "");
      if (expected && typeof evidence.readbackContent === "string") {
        const ok = evidence.readbackContent.includes(expected.slice(0, 100));
        return {
          passed: ok,
          evidence: `文件已回读 (${evidence.readbackContent.length} chars)`,
          reason: ok ? undefined : "回读内容与预期不符",
        };
      }
      return { passed: true, evidence: `文件已确认存在 (${evidence.sizeBytes ?? "?"} bytes)` };
    }
    case "delete_file": {
      const ok = evidence.targetExists === false;
      return { passed: ok, evidence: ok ? "目标已确认删除" : "目标仍存在", reason: ok ? undefined : "删除后目标仍在" };
    }
    case "execute_command": {
      const cmd = String(args.command ?? "");
      if (/\bkill\b|\bpkill\b|\bstop\b/.test(cmd)) {
        const ok = evidence.processStillRunning === false;
        return { passed: ok, evidence: ok ? "进程已确认停止" : "进程仍在运行", reason: ok ? undefined : "kill 后进程仍存活" };
      }
      if (evidence.targetExists !== undefined) {
        return {
          passed: evidence.targetExists,
          evidence: evidence.targetExists ? "重定向目标已确认存在" : "",
          reason: evidence.targetExists ? undefined : "重定向目标不存在",
        };
      }
      return { passed: true, evidence: "命令已执行（无可独立验证的副作用）" };
    }
    case "use_mastered_tool": {
      // mastered tool 最易假成功：有任何回读证据就据其判定，否则保守标未验证。
      if (evidence.targetExists !== undefined) {
        return { passed: evidence.targetExists, evidence: evidence.targetExists ? "动作效果已确认" : "", reason: evidence.targetExists ? undefined : "动作未产生预期效果" };
      }
      return { passed: true, evidence: "已执行但未独立验证（建议补回读探针）" };
    }
    default:
      return { passed: true, evidence: "no verify rule; passed by default" };
  }
}

/**
 * failedAttempts 防重复犯错：给定历史失败记录与当前动作，判定同一动作连续失败次数
 * 是否达到"该换方案"阈值（缺省 3）。
 */
export function shouldForceNewApproach(
  failedAttempts: ReadonlyArray<{ action: string; reason: string }>,
  currentActionPrefix: string,
  threshold = 3,
): { force: boolean; count: number } {
  const count = failedAttempts.filter((f) => f.action.startsWith(currentActionPrefix)).length;
  return { force: count >= threshold, count };
}
