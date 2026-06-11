/**
 * 持续执行内核 · 配置地基（execution-config.ts）
 * ------------------------------------------------------------------
 * 镜像 cognitive-config.ts / narrative-config.ts 范式：定义执行模式、内核配置、
 * 默认常量，与一个最小只读接口 MindExecReadLike（结构子类型，不反向 import riverMain.ts）。
 *
 * 缺省 mode="observe"：对既有行为逐字节零改变；enabledStages 全 false。
 * _Requirements: 1.6, 2.8, 7.1_
 */

/** observe = 只观测、不改既有行为（默认）；enforce = 内核真正接管执行循环。 */
export type ExecutionMode = "observe" | "enforce";

/** 五段脊柱的启用开关；缺省全 false（逐字节零改变）。 */
export interface ExecutionStageToggles {
  perception: boolean;
  continuation: boolean;
  definitionOfDone: boolean;
  strategy: boolean;
  metaControl: boolean;
}

export interface ExecutionKernelConfig {
  /** 缺省 "observe"。 */
  mode: ExecutionMode;
  /** 防无限循环的大额保险（不防正常等待）；缺省 200。 */
  maxStepsHardCap: number;
  /** 止损：连续低产步阈值；缺省 6。 */
  stallBudget: number;
  /** 策略背离判定窗口；缺省 3。 */
  driftWindow: number;
  /** 各段启用开关；缺省全 false。 */
  enabledStages: ExecutionStageToggles;
}

/** 默认配置：observe + 全 stage false → 缺省逐字节零改变。 */
export const DEFAULT_EXECUTION_KERNEL: ExecutionKernelConfig = {
  mode: "observe",
  maxStepsHardCap: 200,
  stallBudget: 6,
  driftWindow: 3,
  enabledStages: {
    perception: false,
    continuation: false,
    definitionOfDone: false,
    strategy: false,
    metaControl: false,
  },
};

/**
 * 最小只读接口（结构子类型）：宿主 Mind 只要"看起来有" executionKernel 字段即可，
 * 不要求 import 宿主类型，从而不反向耦合 riverMain.ts。
 */
export interface MindExecReadLike {
  executionKernel?: ExecutionKernelConfig;
}

/** 深拷贝默认配置，避免共享引用被调用方意外改写。 */
function cloneDefault(): ExecutionKernelConfig {
  return {
    mode: DEFAULT_EXECUTION_KERNEL.mode,
    maxStepsHardCap: DEFAULT_EXECUTION_KERNEL.maxStepsHardCap,
    stallBudget: DEFAULT_EXECUTION_KERNEL.stallBudget,
    driftWindow: DEFAULT_EXECUTION_KERNEL.driftWindow,
    enabledStages: { ...DEFAULT_EXECUTION_KERNEL.enabledStages },
  };
}

/**
 * 纯函数：mind 有 executionKernel 则返回其规整副本，缺省返回默认深拷贝。
 * 绝不修改入参 mind。
 */
export function resolveExecutionConfig(mind: MindExecReadLike | null | undefined): ExecutionKernelConfig {
  const cfg = mind?.executionKernel;
  if (!cfg) return cloneDefault();
  const base = cloneDefault();
  return {
    mode: cfg.mode === "enforce" ? "enforce" : "observe",
    maxStepsHardCap:
      typeof cfg.maxStepsHardCap === "number" && Number.isFinite(cfg.maxStepsHardCap) && cfg.maxStepsHardCap > 0
        ? Math.floor(cfg.maxStepsHardCap)
        : base.maxStepsHardCap,
    stallBudget:
      typeof cfg.stallBudget === "number" && Number.isFinite(cfg.stallBudget) && cfg.stallBudget > 0
        ? Math.floor(cfg.stallBudget)
        : base.stallBudget,
    driftWindow:
      typeof cfg.driftWindow === "number" && Number.isFinite(cfg.driftWindow) && cfg.driftWindow > 0
        ? Math.floor(cfg.driftWindow)
        : base.driftWindow,
    enabledStages: {
      perception: cfg.enabledStages?.perception === true,
      continuation: cfg.enabledStages?.continuation === true,
      definitionOfDone: cfg.enabledStages?.definitionOfDone === true,
      strategy: cfg.enabledStages?.strategy === true,
      metaControl: cfg.enabledStages?.metaControl === true,
    },
  };
}
