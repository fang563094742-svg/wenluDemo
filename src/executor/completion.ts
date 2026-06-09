/**
 * Executor 完成判定纯函数（任务 11.8，R12.5）。
 *
 * 本模块只承载「动作目标相关性校验」的**纯函数**，不含 I/O 与执行逻辑：
 *  - `hasMaterializedRelevantActions`：判断执行循环历史中是否存在「触及任务
 *    primaryTargets 的真实落地动作」。
 *
 * 背景（对抗性审查）：仅判断"有没有落地动作"不足以防伪——LLM 可用一堆**无关**
 * 的真实动作（如随便写个临时文件、跑个 `echo`）伪装"已落地"。因此把原先的
 * `hasMaterializedActions(log)` 升级为 `hasMaterializedRelevantActions(log, primaryTargets)`：
 * 不仅要求存在真实落地动作，**还要求至少一个落地动作触及 primaryTargets**
 * （路径匹配，或命令参数包含目标）。Executor 执行循环在 LLM 声称完成时调用本函数，
 * 若返回 false 则拒绝判定完成、回灌提示 LLM「请对目标文件/目录执行实际更改，
 * 不要只做无关操作」。
 *
 * _Requirements: 12.5_
 */

import type { ToolInvocation } from "./types.js";

/**
 * 「真实落地」工具集合：这些工具一旦成功执行且未被安全门拦截，即对 Working_Directory
 * 产生了真实副作用（写文件 / 跑命令 / 删文件），区别于 read_file / list_dir 等只读动作。
 */
const MATERIALIZING_TOOLS = new Set<string>([
  "write_file",
  "run_command",
  "delete_file",
]);

/**
 * 纯函数：执行历史中是否存在「触及 primaryTargets 的真实落地动作」（R12.5）。
 *
 * 判定规则：
 *  1. 先筛出**真实落地动作**——工具名属于 {write_file, run_command, delete_file}、
 *     `result.ok === true`、且 `blocked !== true`（未被 sandbox/符号链接逃逸门拦截）。
 *  2. 若一个真实落地动作都没有 → 直接返回 `false`（连落地都没发生，谈不上完成）。
 *  3. 若 `primaryTargets` 为空（undefined 或长度 0）→ 退化为「有任一真实落地动作即可」，
 *     返回 `true`（无明确目标时不要求相关性）。
 *  4. 否则要求**至少一个**真实落地动作触及某个 primaryTarget：把该动作的 `arguments`
 *     序列化为字符串后，只要包含任一 target 子串即视为触及（覆盖 `{path}` 路径匹配
 *     与 `{command}` 命令参数包含目标两种情形）。
 *
 * @param log           执行循环逐步累积的工具调用记录。
 * @param primaryTargets 任务真正要改动的文件/目录/项目（Task_Frame.primaryTargets），可空。
 * @returns 存在触及目标的真实落地动作时为 `true`，否则 `false`。
 */
export function hasMaterializedRelevantActions(
  log: ToolInvocation[],
  primaryTargets: string[] | undefined,
): boolean {
  const materialized = log.filter(
    (inv) =>
      MATERIALIZING_TOOLS.has(inv.tc.name) && inv.result.ok && !inv.blocked,
  );

  // 连真实落地动作都没有：不可能算完成。
  if (materialized.length === 0) return false;

  // 无明确目标时退化为「只要有真实落地动作即可」。
  if (!primaryTargets || primaryTargets.length === 0) return true;

  // 至少一个落地动作触及某个 primaryTarget（路径匹配 或 命令参数含目标）。
  return materialized.some((inv) => {
    const blob = JSON.stringify(inv.tc.arguments ?? {});
    return primaryTargets.some((t) => blob.includes(t));
  });
}
