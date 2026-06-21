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

export interface FlywheelRankingParams {
  ucb1C: number;
  recencyDecayDays: number;
  recencyMaxBoost: number;
  exploreWeight: number;
  freshWeight: number;
  routerMinRelevance: number;
}

export interface FlywheelConfig {
  mode: FlywheelMode;
  enabled: FlywheelToggles;
  /** 技能被信任复用前需累积的客观验证成功次数（缺省 1）。 */
  minVerifyToTrust: number;
  ranking: FlywheelRankingParams;
}

export const DEFAULT_RANKING: FlywheelRankingParams = {
  ucb1C: 0.5,
  recencyDecayDays: 7,
  recencyMaxBoost: 0.3,
  exploreWeight: 0.3,
  freshWeight: 0.2,
  routerMinRelevance: 0.3,
};

export const DEFAULT_FLYWHEEL: FlywheelConfig = {
  mode: "observe",
  enabled: { router: false, distiller: false },
  minVerifyToTrust: 1,
  ranking: { ...DEFAULT_RANKING },
};

export interface MindFlywheelReadLike {
  skillFlywheel?: FlywheelConfig;
}

function cloneDefault(): FlywheelConfig {
  return {
    mode: DEFAULT_FLYWHEEL.mode,
    enabled: { ...DEFAULT_FLYWHEEL.enabled },
    minVerifyToTrust: DEFAULT_FLYWHEEL.minVerifyToTrust,
    ranking: { ...DEFAULT_RANKING },
  };
}

/** 纯函数：mind 有 skillFlywheel 则规整返回，缺省返回默认深拷贝；绝不修改入参。 */
export function resolveFlywheelConfig(mind: MindFlywheelReadLike | null | undefined): FlywheelConfig {
  const cfg = mind?.skillFlywheel;
  if (!cfg) return cloneDefault();
  const base = cloneDefault();
  const r = cfg.ranking;
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
    ranking: {
      ucb1C: finiteOr(r?.ucb1C, base.ranking.ucb1C),
      recencyDecayDays: finiteOr(r?.recencyDecayDays, base.ranking.recencyDecayDays),
      recencyMaxBoost: finiteOr(r?.recencyMaxBoost, base.ranking.recencyMaxBoost),
      exploreWeight: finiteOr(r?.exploreWeight, base.ranking.exploreWeight),
      freshWeight: finiteOr(r?.freshWeight, base.ranking.freshWeight),
      routerMinRelevance: finiteOr(r?.routerMinRelevance, base.ranking.routerMinRelevance),
    },
  };
}

function finiteOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : fallback;
}
