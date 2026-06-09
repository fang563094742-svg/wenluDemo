/**
 * Confidence_Statement 机械生成（R8.8，任务 7.7）。
 *
 * 核心命题（design.md「sufficient 阶段 — Task_Frame 组装」）：
 *   `Confidence_Statement` 由 Clarifier 直接从 `resolvedPreconditions` 的
 *   `resolvedBy` 字段**机械生成**，不依赖 LLM，保证透明可靠：
 *     - resolvedBy === "user_input"      → basedOnUserInput
 *     - resolvedBy === "default_accepted" → basedOnDefaultAssumption
 *
 * 由此满足 Property 10（划分完备且不重叠）：对任一已消解前提集合，
 * `basedOnUserInput` 恰含所有 resolvedBy="user_input" 的前提，
 * `basedOnDefaultAssumption` 恰含所有 resolvedBy="default_accepted" 的前提，
 * 两列表并集等于全部已消解前提、交集为空。
 *
 * 纯函数：无副作用、不调用 LLM、对同一输入产出确定输出。
 *
 * _Requirements: 8.8_
 */

import type {
  Confidence_Statement,
  Execution_Precondition,
} from "./types.js";

/**
 * 取某个已消解前提对外披露的值。
 *
 * 优先用用户/默认消解时落定的 `resolvedValue`；其缺省时退化到 `proposedDefault`
 * （多见于「接受默认值」路径）；两者皆无则以空串占位，保证字段恒为字符串。
 */
function disclosedValue(p: Execution_Precondition): string {
  return p.resolvedValue ?? p.proposedDefault ?? "";
}

/**
 * 从已消解前提集合机械生成 `Confidence_Statement`（R8.8）。
 *
 * 仅按 `resolvedBy` 划分；`resolvedBy` 未设置（尚未消解）的前提既不属于
 * 用户输入、也不属于默认假设，按"非已消解前提"排除在外，从而保证划分
 * 在「已消解前提」这一全集上既完备又不重叠。
 *
 * @param resolvedPreconditions 已消解（或部分含未消解）的前提集合，
 *   通常取自 `Task_Frame.resolvedPreconditions`。
 * @returns 区分「基于用户输入」与「基于默认假设」两类的置信度说明。
 */
export function generateConfidenceStatement(
  resolvedPreconditions: readonly Execution_Precondition[],
): Confidence_Statement {
  const basedOnUserInput: Confidence_Statement["basedOnUserInput"] = [];
  const basedOnDefaultAssumption: Confidence_Statement["basedOnDefaultAssumption"] =
    [];

  for (const p of resolvedPreconditions) {
    const entry = { precondition: p.description, value: disclosedValue(p) };
    switch (p.resolvedBy) {
      case "user_input":
        basedOnUserInput.push(entry);
        break;
      case "default_accepted":
        basedOnDefaultAssumption.push(entry);
        break;
      default:
        // resolvedBy 未设置：尚未消解，不纳入任一类别（保持划分在已消解前提上完备）。
        break;
    }
  }

  return { basedOnUserInput, basedOnDefaultAssumption };
}
