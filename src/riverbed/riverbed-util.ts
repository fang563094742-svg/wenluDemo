/**
 * 河床系统 · 跨模块共享基础类型与工具
 * ------------------------------------------------------------------
 * 本文件是河床（Riverbed System）所有模块的共享底座，只包含：
 *  1. `clamp01`：把任意数值归一到 [0,1] 区间的纯函数。
 *  2. `MindLike`：河床模块读取 mind 时所需字段的最小接口——
 *     供河床引用 mind 而不反向依赖 `riverMain.ts` 的完整 `Mind` 接口，
 *     从而避免 riverMain ↔ riverbed 的循环依赖。
 *
 * 绝对边界（贯穿全河床，参见 requirements.md Requirement 14）：
 *  - 不 import 任何 3.1 / 3.2 路径的代码。
 *  - 不 import `node:sqlite`。
 *  - 不写 `import "server-only"`。
 *  - 不读取环境变量 / 配置文件，不开网络端点，不执行命令。
 *
 * 本文件为纯 TypeScript ESM，沿用弟弟约定（相对导入用 `.js` 扩展）。
 */

/**
 * 把任意数值约束到 [0,1] 区间。
 *
 * 归一规则（确定性纯函数）：
 *  - `NaN`（含非有限值）→ 0
 *  - 负数 → 0
 *  - 大于 1 → 1
 *  - 其余 → 原值
 *
 * @param value 任意数值（可能是 NaN / 负数 / >1）
 * @returns 位于 [0,1] 闭区间的数值
 */
export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * mind 内一条结构化 belief 的最小读取形状。
 * 河床仅需读取以下字段作为证据来源与域映射输入。
 */
export interface MindBeliefLike {
  id: string;
  dimension: string;
  content: string;
  confidence: number;
}

/**
 * mind 内一条用户洞察（userModel）的最小读取形状。
 */
export interface MindUserInsightLike {
  id: string;
  aspect: string;
  content: string;
  confidence: number;
}

/**
 * mind 内一条对话记录的最小读取形状。
 */
export interface MindConversationEntryLike {
  role: "user" | "wenlu";
  text: string;
  time: string;
}

/**
 * mind 内一条预测账本记录的最小读取形状。
 * 河床的回光校准（reflux）只需读取 status 与关联域字段。
 */
export interface MindPredictionLike {
  id: string;
  status: "open" | "hit" | "miss" | "expired";
  /** 关联的 belief / 目标维度（可选）——reflux 用于匹配落空预测到对应域 */
  relatedTo?: string;
}

/**
 * mind 客观成长指标的最小读取形状。
 * 河床回光校准只需命中率。
 */
export interface MindMetricsLike {
  predictionHitRate?: number;
  predictionsSettled?: number;
}

/**
 * 河床读取 mind 所需字段的最小集合（`MindLike`）。
 *
 * 这是 riverMain.ts 完整 `Mind` 接口的结构化子集——河床模块只依赖
 * 这个最小接口，不反向 import riverMain.ts，杜绝循环依赖。
 * 完整 `Mind` 天然满足 `MindLike`（结构化子类型）。
 */
export interface MindLike {
  beliefs: MindBeliefLike[];
  userModel: MindUserInsightLike[];
  conversation: MindConversationEntryLike[];
  cycles: number;
  metrics: MindMetricsLike;
  predictions?: MindPredictionLike[];
}
