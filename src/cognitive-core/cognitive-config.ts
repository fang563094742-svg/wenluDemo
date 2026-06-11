/**
 * 认知核三段脊柱 · 配置与默认模块（Component 5：cognitive-config.ts）
 * ------------------------------------------------------------------
 * 定义认知核的工作模式 `CognitiveMode`、可选轻量配置 `CognitiveCoreConfig`、
 * 常量默认 `DEFAULT_COGNITIVE_CORE`，以及从 mind 读取配置、缺省回退默认的
 * 确定性纯函数 `resolveCognitiveConfig`。配置走 mind 顶层【单个】可选字段
 * `cognitiveCore?`，mind 无该字段时回退常量默认（向后兼容、零行为改变）。
 *
 * 设计要点（参见 design.md Component 5 与「最高约束章·约束 5」）：
 *  - `DEFAULT_COGNITIVE_CORE` 默认 `mode="dry-run"`、`enabledStages` 全 false，
 *    使缺省接入对既有行为零改变（逐字节一致）。
 *  - `maxParallel=4` 对齐既有 `MAX_PARALLEL`，`outputCharBudget=200` 为超长治理预算。
 *  - `resolveCognitiveConfig` 为确定性纯函数：含 `cognitiveCore` 则返回该配置，
 *    缺省返回 `DEFAULT_COGNITIVE_CORE` 的深拷贝；不修改入参 mind、无副作用。
 *
 * 绝对边界（贯穿全认知核，参见 design.md「最高约束章·约束 4」）：
 *  - 不 import 任何 3.1 / 3.2 路径的代码、不调其 API、不碰其 sqlite。
 *  - 不 import "server-only"、不 import "node:sqlite"、不用 @/lib 路径别名。
 *  - 不反向 import `riverMain.ts`（经 `MindConfigReadLike` 风格的最小只读接口解耦）。
 *  - 纯 TypeScript ESM，相对导入一律带 `.js` 扩展（Node ≥ 22）。
 *  - 零第三方运行时依赖（最多 `node:crypto`，本模块未用）。
 */

/**
 * 认知核工作模式。
 *  - `dry-run`：观察模式（默认）。三段脊柱只生成内部对象供观察、零行为改变，
 *    Intent 不落地执行、Output 终态恒为 `suppressed`（不外溢）。
 *  - `enforce`：显式启用脊柱落地执行的工作模式，仍降级安全（fail-open）。
 */
export type CognitiveMode = "dry-run" | "enforce";

/**
 * 三段脊柱的分段启用开关。
 *
 * 缺省全 false，使缺省接入对既有行为零改变；按需逐段启用，互不强耦合。
 */
export interface CognitiveStageToggles {
  /** 规划核 PlanKernel 是否启用。 */
  plan: boolean;
  /** 调度核 DispatchKernel 是否启用。 */
  dispatch: boolean;
  /** 输出核 OutputKernel 是否启用。 */
  output: boolean;
}

/**
 * 认知核可选轻量配置。
 *
 * 挂在 mind 顶层 `cognitiveCore?` 字段；缺省即用 {@link DEFAULT_COGNITIVE_CORE}。
 */
export interface CognitiveCoreConfig {
  /** 工作模式：dry-run（观察，默认，零行为改变）/ enforce（启用落地）。 */
  mode: CognitiveMode;
  /** 并行预算（默认 4，对齐既有 `MAX_PARALLEL`）。 */
  maxParallel: number;
  /** 对用户输出的字符预算（默认 200，超长治理副产品）。 */
  outputCharBudget: number;
  /** 三段脊柱分段启用开关（默认全 false，缺省零行为改变）。 */
  enabledStages: CognitiveStageToggles;
}

/**
 * 常量默认（mind 无 `cognitiveCore` 字段时使用，向后兼容、最保守）。
 *
 * 默认 `mode="dry-run"`、`enabledStages` 全 false，使缺省接入对既有行为
 * 逐字节零改变；`maxParallel=4` 对齐既有 `MAX_PARALLEL`，`outputCharBudget=200`。
 */
export const DEFAULT_COGNITIVE_CORE: CognitiveCoreConfig = {
  mode: "dry-run",
  maxParallel: 4,
  outputCharBudget: 200,
  enabledStages: { plan: false, dispatch: false, output: false },
};

/**
 * 认知核读取【配置】所需的 mind 最小只读接口（解耦核心）。
 *
 * 完整 Mind 天然满足此结构子类型；认知核不反向 import `riverMain.ts`，
 * 仅通过该最小接口解耦读取配置。可选字段缺省时回退常量默认、绝不抛错。
 */
export interface MindConfigReadLike {
  /** 可选认知核配置；缺省即回退 {@link DEFAULT_COGNITIVE_CORE}。 */
  cognitiveCore?: CognitiveCoreConfig;
}

/**
 * 从 mind 读取认知核配置，缺省回退常量默认（确定性纯函数，不修改入参 mind）。
 *
 * - mind 含 `cognitiveCore` 字段 → 返回该配置。
 * - mind 缺省 `cognitiveCore` → 返回 {@link DEFAULT_COGNITIVE_CORE} 的深拷贝
 *   （避免调用方拿到对常量的引用进而意外改写共享默认，含 `enabledStages` 对象）。
 *
 * @param mind 只读最小 mind 接口。
 * @returns 解析后的 {@link CognitiveCoreConfig}。
 */
export function resolveCognitiveConfig(
  mind: MindConfigReadLike,
): CognitiveCoreConfig {
  if (mind.cognitiveCore !== undefined) {
    return mind.cognitiveCore;
  }
  return cloneDefaultCognitiveCore();
}

/**
 * 返回 {@link DEFAULT_COGNITIVE_CORE} 的深拷贝。
 *
 * 优先用 `structuredClone`（Node ≥ 17 全局可用）；理论上不可用时手动展开兜底，
 * 确保 `enabledStages` 对象亦为新引用，不与常量共享可变状态。
 */
function cloneDefaultCognitiveCore(): CognitiveCoreConfig {
  if (typeof structuredClone === "function") {
    return structuredClone(DEFAULT_COGNITIVE_CORE);
  }
  return {
    ...DEFAULT_COGNITIVE_CORE,
    enabledStages: { ...DEFAULT_COGNITIVE_CORE.enabledStages },
  };
}
