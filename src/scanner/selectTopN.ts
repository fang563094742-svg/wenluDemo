/**
 * proactive-awareness-demo —— Top N 精选纯函数（任务 4.4）。
 *
 * 两段式扫描的「阶段2 精选」核心：对粗筛得到的带打分候选条目，按 `score` **降序**
 * 取前 N 条，组装进 `Scan_Summary`（design.md「Mac_Scanner 两段式实现」R3.4）。
 * 仅精选后的 Top N 外传给 Analyzer，原始粗筛数据不外传（R3.5）。
 *
 * 本函数是**纯函数**（无副作用、不修改入参、同输入同输出，R1.4 扫描产出确定性），
 * 便于 property-based testing（对应 design.md「Correctness Properties」Property 3）。
 *
 * 不变量（Property 3「Top N 精选正确性」）：
 *  - 结果长度 ≤ N；
 *  - 结果元素**全部来自输入集合**（不引入外来项）；
 *  - 结果为按 `score` 降序排列的**前 N 个**；
 *  - 不重复（不把同一个输入元素纳入多次）。
 *
 * _Requirements: 3.4, 1.4_
 */

import type { ScanSummaryItem } from "./types.js";

/**
 * 从带打分的候选条目中按 `score` 降序精选前 N 条。
 *
 * 实现要点：
 *  - **不修改入参**：在副本上排序（`[...items]`），保持纯函数语义。
 *  - **稳定排序**：分数相等时保持输入原有相对顺序（ES2019+ `Array.prototype.sort`
 *    保证稳定），使「同输入 → 同输出」确定（R1.4）。
 *  - **N 归一化**：`Math.floor` 向下取整后与 0 取大；N ≤ 0（含负数 / NaN）时返回空数组；
 *    N 超过候选数时返回全部（已排序）。`slice` 天然处理越界，不会引入外来项。
 *
 * @param items 粗筛得到的带打分候选条目集合（不会被修改）。
 * @param n     精选数量上限（期望为正整数；非正 / 非数则视作 0）。
 * @returns 按 `score` 降序排列的前 N 条（长度 ≤ N，元素均来自 `items`，无重复）。
 */
export function selectTopN(
  items: readonly ScanSummaryItem[],
  n: number,
): ScanSummaryItem[] {
  // N 归一化：非正整数 / NaN 一律退化为 0，确保结果长度 ≤ N 且不为负。
  const limit = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  if (limit === 0 || items.length === 0) {
    return [];
  }

  // 在副本上稳定降序排序（不修改入参），再取前 limit 条。
  // 分数相等时保持原有相对顺序（稳定排序），保证确定性输出。
  return [...items]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
