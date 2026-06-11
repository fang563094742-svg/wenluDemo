/**
 * 技能复利飞轮 · 配置地基（flywheel-config.ts）
 * ------------------------------------------------------------------
 * 缺省 mode="observe"（只记录候选技能、不改行为）+ 全 enabled 关闭 → 逐字节零改变。
 * minVerifyToTrust：技能被信任复用前需累积的客观验证成功次数。
 * 镜像 sovereign/execution-kernel 范式：纯函数 resolve，不反向 import riverMain。
 * _Requirements: 7.1, 6.4_
 */

export type FlywheelMode = "observe" | "enforce";

export interface FlywheelToggles {
  router: boolean;
  distiller: boolean;
}

export interface FlywheelConfig {
  mode: FlywheelMode;
  enabled: FlywheelToggles;
  /** 技能被信任复用前需累积的客观验证成功次数（缺省 1）。 */
  minVerifyToTrust: number;
}

export const DEFAULT_FLYWHEEL: FlywheelConfig = {
  mode: "observe",
  enabled: { router: false, distiller: false },
  minVerifyToTrust: 1,
};

export interface MindFlywheelReadLike {
  skillFlywheel?: FlywheelConfig;
}

function cloneDefault(): FlywheelConfig {
  return {
    mode: DEFAULT_FLYWHEEL.mode,
    enabled: { ...DEFAULT_FLYWHEEL.enabled },
    minVerifyToTrust: DEFAULT_FLYWHEEL.minVerifyToTrust,
  };
}

/** 纯函数：mind 有 skillFlywheel 则规整返回，缺省返回默认深拷贝；绝不修改入参。 */
export function resolveFlywheelConfig(mind: MindFlywheelReadLike | null | undefined): FlywheelConfig {
  const cfg = mind?.skillFlywheel;
  if (!cfg) return cloneDefault();
  const base = cloneDefault();
  return {
    mode: cfg.mode === "enforce" ? "enforce" : "observe",
    enabled: {
      router: cfg.enabled?.router === true,
      distiller: cfg.enabled?.distiller === true,
    },
    minVerifyToTrust:
      typeof cfg.minVerifyToTrust === "number" && Number.isFinite(cfg.minVerifyToTrust) && cfg.minVerifyToTrust >= 0
        ? Math.floor(cfg.minVerifyToTrust)
        : base.minVerifyToTrust,
  };
}
