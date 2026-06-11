/**
 * 认知核三段脊柱 · 调度核（Component 2：dispatch-kernel.ts）
 * ------------------------------------------------------------------
 * 把规划核产出的结构化 `Intent` 主动分解成可并行的执行线，依据
 * `Subgoal.dependsOn` 做拓扑排序、按 `maxParallel` 切波，产出只描述
 * "怎么打"的 `DispatchPlan`。落地交给既有 `spawnTask`（本组件不自造执行）。
 *
 * 本模块实现（参见 design.md「Algorithm 2」「Component 2」「Correctness
 * Properties · P4/P5/P6/P7」）：
 *
 *  - `dispatch(intent, opts?)`：纯函数、确定性、不修改入参 `intent`。
 *    - 拓扑排序：每轮取"入度为 0 且依赖已全部排定（dependsOn ⊆ scheduled）"
 *      的就绪 subgoal。
 *    - 就绪集按优先级降序 `sortByPriorityDesc`（优先级由依赖数 / 原始顺序确定性
 *      推导，相同则按 id 字典序稳定）。
 *    - 按 `maxParallel`（缺省 4）切波：每个 wave 的 `lines` 数 ≤ maxParallel。
 *    - 产出 `DispatchPlan{ waves, rationale }`；`rationale` 仅供调试观察，非外溢。
 *    Postcondition：每个 subgoal 在 `waves` 中恰好出现一次（双射）；任一 wave_k
 *    中 line 的 `dependsOn` 全部出现在严格更早的 wave（∪_{j<k} wave_j）；每个
 *    wave 的 line 数 ≤ maxParallel。
 *  - 环检测：`remaining` 非空但就绪集 `ready` 为空 ⟹ 抛 `DispatchCycleError`。
 *  - `dispatchSafe(intent, opts?)`：catch `DispatchCycleError` 后降级为"全部
 *    subgoal 串行单波"（每波 1 条 line，按原顺序），不抛。
 *
 * 绝对边界（贯穿全认知核，参见 design.md「最高约束章·约束 4」）：
 *  - 不 import 任何 3.1 / 3.2 路径代码、不调其 API、不碰其 sqlite。
 *  - 不 import "server-only"、不 import "node:sqlite"、不用 @/lib 路径别名。
 *  - 不反向 import `riverMain.ts`。
 *  - 纯 TypeScript ESM，相对导入一律带 `.js` 扩展（Node ≥ 22）。
 *  - 零第三方运行时依赖。
 */

import type {
  DispatchLine,
  DispatchOptions,
  DispatchPlan,
  DispatchWave,
  Intent,
  Subgoal,
} from "./types.js";

/** 缺省并行预算，对齐既有 `MAX_PARALLEL = 4`。 */
const DEFAULT_MAX_PARALLEL = 4;

/**
 * 调度发现环时抛出的错误：`remaining` 非空但找不到任何就绪 subgoal。
 *
 * 由调用点（或 `dispatchSafe`）catch 后降级为"全部串行单波"，不阻断主链。
 */
export class DispatchCycleError extends Error {
  constructor(message = "DispatchKernel detected a cycle: no ready subgoal while remaining is non-empty") {
    super(message);
    this.name = "DispatchCycleError";
    // 维持 instanceof 在向下编译 (ES5 target) 时的可靠性。
    Object.setPrototypeOf(this, DispatchCycleError.prototype);
  }
}

/**
 * 由 subgoal 确定性推导优先级（越大越先打）。
 *
 * 取向：依赖越少的越"靠根"、越该先打，故以 `-dependsOn.length` 为主键
 * （依赖数小 ⟹ 优先级高）。该推导纯依赖 subgoal 自身字段，确定性可测。
 */
function derivePriority(subgoal: Subgoal): number {
  return -subgoal.dependsOn.length;
}

/**
 * 把就绪集按优先级降序稳定排序：优先级高者在前；优先级相同按 id 字典序稳定。
 *
 * 纯函数：返回新数组，不修改入参。
 */
function sortByPriorityDesc(ready: ReadonlyArray<Subgoal>): Subgoal[] {
  return [...ready].sort((a, b) => {
    const pa = derivePriority(a);
    const pb = derivePriority(b);
    if (pa !== pb) {
      return pb - pa; // 优先级降序
    }
    // 相同优先级按 id 字典序稳定，保证确定性。
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });
}

/**
 * 把一个 subgoal 物化为执行线 `DispatchLine`。
 */
function makeLine(subgoal: Subgoal): DispatchLine {
  return {
    subgoalId: subgoal.id,
    goal: subgoal.goal,
    priority: derivePriority(subgoal),
    dependsOn: [...subgoal.dependsOn],
  };
}

/**
 * 把若干 subgoal 物化为一波 `DispatchWave`。
 */
function makeWave(chunk: ReadonlyArray<Subgoal>): DispatchWave {
  return { lines: chunk.map(makeLine) };
}

/**
 * 调度核主算法：从 DAG `Intent` 产出拓扑分波的 `DispatchPlan`。
 *
 * 纯函数、确定性、不修改入参 `intent`。
 *
 * @param intent 规划核产出的 Intent（`subgoals` 须构成 DAG）。
 * @param opts   可选项；`maxParallel` 缺省 4。
 * @returns 编排计划 `DispatchPlan{ waves, rationale }`。
 * @throws {DispatchCycleError} 当 `remaining` 非空但找不到就绪 subgoal（含环）。
 */
export function dispatch(intent: Intent, opts?: DispatchOptions): DispatchPlan {
  const maxParallel =
    opts && opts.maxParallel >= 1 ? opts.maxParallel : DEFAULT_MAX_PARALLEL;

  // 不修改入参：复制为可变剩余集合。
  const remaining: Subgoal[] = [...intent.subgoals];
  const scheduled = new Set<string>();
  const waves: DispatchWave[] = [];

  while (remaining.length > 0) {
    // 循环不变量：scheduled 中每个 subgoal 的 dependsOn 全部已在 scheduled。
    const ready = remaining.filter((s) =>
      s.dependsOn.every((dep) => scheduled.has(dep)),
    );

    if (ready.length === 0) {
      // remaining 非空但无就绪 → 存在环（违反前置 DAG）。
      throw new DispatchCycleError();
    }

    const sorted = sortByPriorityDesc(ready);

    // 按 maxParallel 切波：每波 lines 数 ≤ maxParallel。
    for (let i = 0; i < sorted.length; i += maxParallel) {
      const chunk = sorted.slice(i, i + maxParallel);
      waves.push(makeWave(chunk));
      for (const sg of chunk) {
        scheduled.add(sg.id);
      }
    }

    // 从 remaining 移除本轮已排定的就绪 subgoal。
    const readyIds = new Set(ready.map((s) => s.id));
    for (let i = remaining.length - 1; i >= 0; i -= 1) {
      if (readyIds.has(remaining[i].id)) {
        remaining.splice(i, 1);
      }
    }
  }

  return {
    waves,
    rationale: explain(waves),
  };
}

/**
 * 调用点降级辅助：catch `DispatchCycleError` 后退化为"全部 subgoal 串行单波"
 * （每波 1 条 line，按原顺序），不抛。
 *
 * 纯函数、确定性、不修改入参 `intent`。
 *
 * @param intent 规划核产出的 Intent。
 * @param opts   可选项（透传 `dispatch`）。
 * @returns 编排计划 `DispatchPlan`；含环时降级为串行单波。
 */
export function dispatchSafe(
  intent: Intent,
  opts?: DispatchOptions,
): DispatchPlan {
  try {
    return dispatch(intent, opts);
  } catch (e) {
    if (e instanceof DispatchCycleError) {
      // 降级：按原顺序每个 subgoal 自成一波（串行），不阻断主链。
      const waves: DispatchWave[] = intent.subgoals.map((sg) => ({
        lines: [makeLine(sg)],
      }));
      return {
        waves,
        rationale: "fallback-serial: cycle detected, degraded to sequential single-line waves",
      };
    }
    throw e;
  }
}

/**
 * 生成 `DispatchPlan.rationale`（仅供调试观察，非外溢文本）。
 */
function explain(waves: ReadonlyArray<DispatchWave>): string {
  const totalLines = waves.reduce((sum, w) => sum + w.lines.length, 0);
  return `topo-dispatch: ${waves.length} wave(s), ${totalLines} line(s)`;
}

/**
 * 可选的 DispatchKernel 接口对象聚合（沿用 design.md「Component 2」接口形态）。
 */
export const DispatchKernel = {
  dispatch,
  dispatchSafe,
} as const;
