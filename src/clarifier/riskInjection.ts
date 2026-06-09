/**
 * Clarifier 风险注入（任务 7.2，R8.2）。
 *
 * 「风险注入」对每个 `Execution_Precondition` 的 `related_action` 评定最终
 * `risk_level`，遵循设计中的两条规则（design.md「执行前提清单 + 风险注入」）：
 *
 *  1. **规则强制高危（规则优先于 LLM 常识）**：动作涉及
 *     **删除 / 权限修改 / sudo / 不可逆操作 / force push** → 一律 `high`。
 *     这组规则与 `executor` 的 `High_Risk_Guard` 黑名单**同源**（rm/sudo/chmod/
 *     chown/git force push/find -delete/-exec/mkfs/dd 等），保证「澄清阶段判定的
 *     高危」与「执行阶段拦截的高危」口径一致。
 *  2. **其余沿用 LLM**：未命中规则时，保留 LLM 给出的 `low`/`medium`
 *     （若 LLM 已给 `high` 也予以保留——风险注入只升级、从不降级）。
 *
 * 设计取向是**保守**的：`related_action` 是 LLM 产出的自由文本描述（可能中英文
 * 混杂），故规则在命令字面（rm、sudo…）之外，同时匹配自然语言关键词（删除、
 * 权限、不可逆、强制推送…）。宁可多判高危走一次用户确认，也不漏判（与「高危必
 * 确认」原则一致）。
 *
 * 本模块为**纯函数**（无副作用、不触碰文件系统/网络），返回全新对象，便于
 * property-based 测试（见 design.md Property 6，由任务 7.4 覆盖）。
 *
 * _Requirements: 8.2_
 */

import type { Execution_Precondition, RiskLevel } from "./types.js";

/**
 * 规则强制高危的模式集合（与 `High_Risk_Guard` 黑名单同源 + 自然语言关键词扩展）。
 *
 * 因 `related_action` 是自由文本描述而非纯命令串，这里在「命令字面」之外补充了
 * 中英文自然语言关键词，使「描述为‘删除旧日志目录’」与「描述为‘rm -rf logs’」
 * 都能被一致地判为高危。所有正则均大小写不敏感。
 */
const HIGH_RISK_ACTION_PATTERNS: readonly RegExp[] = [
  // —— 删除（命令字面 + 中英文描述）——
  /\brm\b/i, // rm / rm -rf
  /\bdelete[sd]?\b/i, // delete / deletes / deleted
  /\bremov(?:e|es|ed|ing|al)\b/i, // remove / removal …
  /\bunlink\b/i,
  /\bfind\b[^\n]*-delete\b/i, // find … -delete（批量删，rm 正则抓不到）
  /删除|移除|清除|清空/,

  // —— 权限修改 / 提权 ——
  /\bchmod\b/i,
  /\bchown\b/i,
  /\bsudo\b/i,
  /\bchgrp\b/i,
  /权限|提权|改权|授予权限|文件归属|属主/,

  // —— sudo / 提权（英文表述）——
  /\bprivilege\s+escalation\b/i,
  /\bas\s+root\b/i,

  // —— force push ——
  /git\s+push\b[^\n]*(?:--force\b|--force-with-lease\b|\s-f\b)/i,
  /force[-\s]?push/i,
  /强制推送|强推|强制(?:覆盖)?推送/,

  // —— 不可逆 / 破坏性 ——
  /不可逆|无法(?:恢复|撤销|回滚|还原)|破坏性|抹除|覆写|覆盖写入/,
  /\birreversible\b/i,
  /\bdestructive\b/i,
  /\boverwrit(?:e|es|ed|ing)\b/i,

  // —— 其他破坏性命令（与黑名单同源）——
  /\bfind\b[^\n]*-exec\b/i, // find … -exec 可执行任意命令
  /\bmkfs\b/i, // 格式化文件系统
  /\bdd\b/i, // 块级覆写
  />\s*\/dev\//, // 重定向写入设备
  /格式化(?:磁盘|分区|硬盘)?/,

  // —— 运行 shell（任意命令执行面）——
  /\b(?:sh|bash|zsh)\b\s+-c\b/i,
];

/**
 * 判断某个执行动作描述是否命中「规则强制高危」（纯谓词）。
 *
 * 用于风险注入主流程，亦可被澄清编排（7.9）/ 测试单独复用。仅做字符串模式匹配，
 * 不依赖任何外部状态。
 *
 * @param relatedAction 执行前提对应的动作描述（`Execution_Precondition.related_action`）。
 * @returns 命中删除/权限/sudo/不可逆/force push 等高危模式时返回 `true`。
 */
export function isRuleForcedHighRisk(relatedAction: string): boolean {
  if (typeof relatedAction !== "string" || relatedAction.length === 0) {
    return false;
  }
  return HIGH_RISK_ACTION_PATTERNS.some((re) => re.test(relatedAction));
}

/**
 * 解析单个动作的最终风险等级（纯函数）。
 *
 * 规则优先：命中高危规则 → 强制 `"high"`；否则沿用 LLM 给出的等级
 * （`low`/`medium`，或 LLM 已判的 `high`）。风险注入**只升级、从不降级**。
 *
 * @param relatedAction 动作描述。
 * @param llmRiskLevel LLM 对该动作给出的风险等级。
 * @returns 注入规则后的最终风险等级。
 */
export function resolveRiskLevel(
  relatedAction: string,
  llmRiskLevel: RiskLevel,
): RiskLevel {
  return isRuleForcedHighRisk(relatedAction) ? "high" : llmRiskLevel;
}

/**
 * 对单个 `Execution_Precondition` 注入风险（纯函数，返回新对象）。
 *
 * 仅依据 `related_action` 与既有 `risk_level` 重算 `risk_level`，其余字段原样保留。
 * 未命中规则时返回的对象与入参**风险等级一致**（仍是不可变副本）。
 *
 * @param precondition 待注入风险的执行前提（其 `risk_level` 为 LLM 初判值）。
 * @returns 风险等级经规则校正后的全新执行前提对象。
 */
export function injectRisk(
  precondition: Execution_Precondition,
): Execution_Precondition {
  return {
    ...precondition,
    risk_level: resolveRiskLevel(precondition.related_action, precondition.risk_level),
  };
}

/**
 * 对一组 `Execution_Precondition` 批量注入风险（纯函数，返回新数组）。
 *
 * 供 Clarifier 在 `next()` 拿到 LLM 产出的前提清单后统一过一遍风险注入
 * （design.md：「`risk_level` 由 LLM 给出后，需经规则层覆盖…规则优先于模型」）。
 *
 * @param preconditions LLM 产出的执行前提清单。
 * @returns 每项风险等级均经规则校正的新数组（元素亦为新对象）。
 */
export function injectRiskAll(
  preconditions: readonly Execution_Precondition[],
): Execution_Precondition[] {
  return preconditions.map(injectRisk);
}
