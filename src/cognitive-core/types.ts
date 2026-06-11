/**
 * 认知核三段脊柱 · 数据模型与状态机类型（Component 类型地基：types.ts）
 * ------------------------------------------------------------------
 * 定义三段脊柱（PlanKernel → DispatchKernel → OutputKernel）流转的一等公民
 * 对象 `Intent` / `Output` 及其状态机枚举、调度编排模型 `DispatchPlan` 系列、
 * 节点信号 `NodeSignal`、最小只读外部接口（结构子类型解耦），以及确定性纯
 * 函数工具 `isValidDag` 与基于 `node:crypto` 的 id 生成器。
 *
 * 设计要点（参见 design.md「Data Models」「Components and Interfaces」章）：
 *  - `Intent` / `Output` 均为带显式 schema + 状态机的一等公民对象。
 *  - `Intent.subgoals` 必须构成 DAG（无环 + dependsOn 只引用存在 id），由
 *    `isValidDag` 校验；该函数为确定性纯函数，可被 fast-check 直接验证。
 *  - 外部依赖一律经最小只读接口（`GoalGapReadLike` / `PrefrontalReadLike` /
 *    `LlmLike` / `OutputContext`）以结构子类型解耦，不反向 import 真实模块。
 *  - 复用 `cognitive-config.ts` 的 `CognitiveMode`，不重复定义。
 *
 * 绝对边界（贯穿全认知核，参见 design.md「最高约束章·约束 4」）：
 *  - 不 import 任何 3.1 / 3.2 路径代码、不调其 API、不碰其 sqlite。
 *  - 不 import "server-only"、不 import "node:sqlite"、不用 @/lib 路径别名。
 *  - 不反向 import `riverMain.ts`（经最小只读接口解耦）。
 *  - 纯 TypeScript ESM，相对导入一律带 `.js` 扩展（Node ≥ 22）。
 *  - 零第三方运行时依赖（仅 `node:crypto`）。
 */

import { randomBytes } from "node:crypto";
import type { CognitiveMode } from "./cognitive-config.js";

// ─── Intent 数据模型与状态机 ──────────────────────────────────

/**
 * Intent 状态机枚举（参见 design.md「Intent 状态机」）。
 *  - `planned`：规划核刚产出。
 *  - `dispatched`：调度核已编排并落地到 tasks 引擎。
 *  - `executing`：至少一条执行线 running。
 *  - `node_reached`：命中真节点，待输出核裁决。
 *  - `fulfilled`：全部子目标达成。
 *  - `blocked`：卡死，需用户。
 *  - `abandoned`：用户改向 / 放弃。
 */
export type IntentStatus =
  | "planned"
  | "dispatched"
  | "executing"
  | "node_reached"
  | "fulfilled"
  | "blocked"
  | "abandoned";

/**
 * Intent 的子目标。`dependsOn` 指向其它 subgoal id，整体构成 DAG。
 */
export interface Subgoal {
  /** 子目标全局唯一 id。 */
  id: string;
  /** 子目标描述（可直接喂给既有 spawnTask）。 */
  goal: string;
  /** 依赖的其它 subgoal id 列表；构成 DAG（无环 + 只引用存在 id）。 */
  dependsOn: ReadonlyArray<string>;
  /** 该子目标的预期结果声明。 */
  expectedResult: string;
}

/**
 * 规划核产出的一等公民对象。纯内部，绝不外溢到用户。
 */
export interface Intent {
  /** 全局唯一 id，形如 "intent_<ts>_<rand>"。 */
  id: string;
  /** 触发它的用户话（呼吸触发时为 null）。 */
  sourceUtterance: string | null;
  /** 整件事的目标（一句话）。 */
  goal: string;
  /** 目标分解（构成 DAG）。 */
  subgoals: ReadonlyArray<Subgoal>;
  /** 整体预期结果。 */
  expectedResult: string;
  /** 验收线（可对接 delivery/decideAfterVerify）。 */
  acceptanceLine: string;
  /** 当前状态。 */
  status: IntentStatus;
  /** 创建时间（ISO 字符串）。 */
  createdAt: string;
  /** 产生它时的模式（dry-run 不外溢、不落地执行）。 */
  mode: CognitiveMode;
}

// ─── Output 数据模型与状态机 ──────────────────────────────────

/**
 * 输出类型枚举（借鉴 3.1 蓝本的 5 种，registry 可扩展）。
 *  - `content`：信息 / 解释 / 汇报。
 *  - `product`：做成的产物。
 *  - `relationship_action`：关系动作（关心 / 对齐 / 确认）。
 *  - `decision`：需用户拍板的决策点。
 *  - `asset`：沉淀资产（能力 / 知识 / 规则）。
 */
export type WenluOutputType =
  | "content"
  | "product"
  | "relationship_action"
  | "decision"
  | "asset";

/**
 * 输出受众（因人调度）。
 */
export type OutputAudience = "user" | "task_log" | "internal";

/**
 * Output 状态机枚举（参见 design.md「Output 状态机」）。
 *  - `drafted`：condense 刚产出。
 *  - `gated`：已过 narrative 忠实性 / 人格门。
 *  - `emitted`：已落 emit 出口。
 *  - `suppressed`：非真节点 / dry-run，被沉默（不外溢）。
 */
export type OutputStatus = "drafted" | "gated" | "emitted" | "suppressed";

/**
 * 输出核产出的一等公民对象。借鉴 3.1 output-kernel 蓝本（只读参考，不 import）。
 */
export interface Output {
  /** 全局唯一 id，形如 "out_<ts>_<rand>"。 */
  id: string;
  /** 溯源到哪个 Intent。 */
  intentId: string;
  /** 输出类型（5 种蓝本类型，可扩展）。 */
  type: WenluOutputType;
  /** 受众（因人调度）。 */
  audience: OutputAudience;
  /** 当前状态。 */
  status: OutputStatus;
  /** 凝练后人话（受 outputCharBudget 约束）。 */
  text: string;
  /** 方向对齐分，取值闭区间 [0,1]，复用 goalMonitor 差距换算。 */
  directionAlignmentScore: number;
  /** 命中的真节点种类（因节点）。 */
  nodeKind: "done" | "blocked" | "needs_user";
  /** 创建时间（ISO 字符串）。 */
  createdAt: string;
}

// ─── 节点信号与裁决 ───────────────────────────────────────────

/**
 * 执行过程中的节点事件信号。
 */
export interface NodeSignal {
  /** 节点种类：真节点（done/blocked/needs_user）或进度（progress，默认沉默）。 */
  kind: "done" | "blocked" | "needs_user" | "progress";
  /** 关联任务 id（可选）。 */
  taskId?: string;
  /** 节点摘要（缺省时输出核以空摘要兜底）。 */
  summary: string;
}

/**
 * 输出核 `shouldEmit` 的裁决结果。
 */
export interface EmitDecision {
  /** 是否到了该对用户开口的真节点。 */
  emit: boolean;
  /** 裁决原因："done" | "blocked" | "needs_user" | "silent"。 */
  reason: string;
}

// ─── 调度编排模型 ─────────────────────────────────────────────

/**
 * 调度核的可选项。
 */
export interface DispatchOptions {
  /** 并行预算（默认对齐既有 MAX_PARALLEL = 4）。 */
  maxParallel: number;
}

/**
 * 单条执行线（落地时调用既有 spawnTask(goal)）。
 */
export interface DispatchLine {
  /** 对应 subgoal id。 */
  subgoalId: string;
  /** 直接喂给既有 spawnTask 的目标描述。 */
  goal: string;
  /** 优先级（越大越先打）。 */
  priority: number;
  /** 依赖的其它 subgoal id 列表。 */
  dependsOn: ReadonlyArray<string>;
}

/**
 * 一波可并行的执行线（受 maxParallel 约束）。
 */
export interface DispatchWave {
  /** 本波可并行的执行线。 */
  lines: ReadonlyArray<DispatchLine>;
}

/**
 * 编排计划：只描述"怎么打"，落地交给既有 spawnTask（不自造执行）。
 */
export interface DispatchPlan {
  /** 按依赖拓扑分波；同一波内可并行（受 maxParallel 约束）。 */
  waves: ReadonlyArray<DispatchWave>;
  /** 整体说明（供调试与观察，非外溢文本）。 */
  rationale: string;
}

// ─── 最小只读外部接口（结构子类型解耦，不反向 import 真实模块） ──

/**
 * goalMonitor 北极星差距的最小只读视图（结构子类型）。
 *
 * 既有 `GoalMonitorSnapshot` 天然满足此结构；输出核仅据此换算
 * `directionAlignmentScore`，不反向 import `goalMonitor.ts`。
 */
export interface GoalGapReadLike {
  /** 总差距（通常 0–100，越小越对齐）。 */
  gap: number;
}

/**
 * prefrontal 时机判定的最小只读视图（结构子类型）。
 *
 * 既有 `PrefrontalDecision` 天然满足此结构；输出核 `shouldEmit` 借此复用
 * 时机肌肉，不反向 import `prefrontal.ts`。
 */
export interface PrefrontalReadLike {
  /** 前额叶决策动作（如 "force-report" / "reply-user" / "breathe" 等）。 */
  action: string;
  /** 可选优先级标注。 */
  priority?: string;
  /** 可选上下文说明。 */
  context?: string;
}

/**
 * 规划核组装 Intent 上下文的最小只读上下文（结构子类型，不反向 import riverMain）。
 */
export interface PlanContext {
  /** 用户刚说的话（呼吸触发时为 null）。 */
  userUtterance: string | null;
  /** 最近对话（只读）。 */
  recentConversation: ReadonlyArray<{ role: string; text: string }>;
  /** 复用 goalMonitor 的差距信号（只读，可选）。 */
  northStarGap?: GoalGapReadLike;
  /** 只读复用 riverbed render 产出（可选）。 */
  riverbedReasons?: ReadonlyArray<string>;
  /** 只读复用 chronotopic render 产出（可选）。 */
  chronoSummaries?: ReadonlyArray<string>;
  /** 工作模式：dry-run | enforce。 */
  mode: CognitiveMode;
}

/**
 * 输出核凝练所需的最小只读上下文（结构子类型）。
 */
export interface OutputContext {
  /** 复用 goalMonitor 的差距信号（只读，可选）。 */
  northStarGap?: GoalGapReadLike;
  /** 工作模式：dry-run 时 Output 终态恒为 suppressed。 */
  mode: CognitiveMode;
  /** 对用户输出的字符预算（凝练裁剪上界）。 */
  outputCharBudget: number;
}

/**
 * 可选 LLM 能力的最小只读接口（谁强用谁；不可用 / 抛错时确定性兜底）。
 *
 * - `refinePlan`：规划核增强用——在确定性骨架基础上增强分解质量；
 *   增强结果非 DAG 或抛错时退回兜底。
 * - `condenseOutput`：输出核凝练用——把节点事件凝练成更贴人话的文本；
 *   不可用 / 抛错时退回确定性凝练。
 */
export interface LlmLike {
  /**
   * 在确定性骨架 `base` 基础上增强 Intent 分解质量。
   * @returns 增强后的 Intent（promise）。
   */
  refinePlan(base: Intent, ctx: PlanContext): Promise<Intent>;
  /**
   * 把节点事件凝练成更贴人话的文本。
   * @returns 凝练后文本（promise）。
   */
  condenseOutput(
    intent: Intent,
    signal: NodeSignal,
    ctx: OutputContext,
  ): Promise<string>;
}

// ─── DAG 校验工具（确定性纯函数） ─────────────────────────────

/**
 * 校验 subgoals 是否构成有向无环图（DAG）：
 *  1. 每个 `dependsOn` 只引用存在的 subgoal id。
 *  2. 整体无环。
 *
 * 确定性纯函数：不修改入参、无副作用、无随机性。
 *
 * @param subgoals 待校验的子目标列表。
 * @returns 构成合法 DAG 返回 true，否则 false。
 */
export function isValidDag(subgoals: ReadonlyArray<Subgoal>): boolean {
  // 建 id 索引；重复 id 视为非法（违反全局唯一）。
  const idToSubgoal = new Map<string, Subgoal>();
  for (const sg of subgoals) {
    if (idToSubgoal.has(sg.id)) {
      return false;
    }
    idToSubgoal.set(sg.id, sg);
  }

  // 引用完整性：每个 dependsOn 必须引用存在的 id，且不自引用。
  for (const sg of subgoals) {
    for (const dep of sg.dependsOn) {
      if (!idToSubgoal.has(dep)) {
        return false;
      }
      if (dep === sg.id) {
        return false;
      }
    }
  }

  // 无环检测：DFS 三色标记（white=0 未访问 / gray=1 在栈 / black=2 已完成）。
  const color = new Map<string, number>();
  for (const sg of subgoals) {
    color.set(sg.id, 0);
  }

  const hasCycleFrom = (startId: string): boolean => {
    // 显式栈迭代 DFS，避免深图递归爆栈；确定性遍历顺序。
    const stack: Array<{ id: string; depIndex: number }> = [
      { id: startId, depIndex: 0 },
    ];
    color.set(startId, 1);

    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const current = idToSubgoal.get(frame.id);
      const deps = current ? current.dependsOn : [];

      if (frame.depIndex < deps.length) {
        const nextId = deps[frame.depIndex];
        frame.depIndex += 1;
        const nextColor = color.get(nextId);
        if (nextColor === 1) {
          return true; // 回到栈中节点 → 有环
        }
        if (nextColor === 0) {
          color.set(nextId, 1);
          stack.push({ id: nextId, depIndex: 0 });
        }
      } else {
        color.set(frame.id, 2);
        stack.pop();
      }
    }
    return false;
  };

  for (const sg of subgoals) {
    if (color.get(sg.id) === 0) {
      if (hasCycleFrom(sg.id)) {
        return false;
      }
    }
  }

  return true;
}

// ─── id 生成器（node:crypto） ─────────────────────────────────

/**
 * 生成随机后缀（十六进制），用于 id 去碰撞。
 */
function randomSuffix(): string {
  return randomBytes(6).toString("hex");
}

/**
 * 生成全局唯一 Intent id，形如 "intent_<ts>_<rand>"。
 */
export function newIntentId(): string {
  return `intent_${Date.now()}_${randomSuffix()}`;
}

/**
 * 生成全局唯一 Output id，形如 "out_<ts>_<rand>"。
 */
export function newOutputId(): string {
  return `out_${Date.now()}_${randomSuffix()}`;
}
