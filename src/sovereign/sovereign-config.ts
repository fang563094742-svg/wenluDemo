/**
 * 主权自体 · 配置地基（sovereign-config.ts）
 * ------------------------------------------------------------------
 * 缺省 mode="shadow"（影子裁决，只记录不改行为）+ 全 cut 关闭 → 逐字节零改变。
 * 切 mode="govern" 才真正掌权。镜像 PolicyWeights 是宪法初始权重，可被 policy-delta 调整。
 * 镜像 cognitive/narrative/execution 范式：纯函数 resolve，不反向 import riverMain。
 * _Requirements: 1.3, 2.5, 7.1_
 */

import type { SignalSource } from "./types.js";

export type SovereignMode = "shadow" | "govern";

export type PolicyWeights = Record<SignalSource, number>;

export interface SovereignCutToggles {
  unify: boolean;
  constitution: boolean;
  mirror: boolean;
  chrono: boolean;
  policy: boolean;
}

export interface SovereignConfig {
  mode: SovereignMode;
  /** 双写影子镜像到 runtime store；缺省 false。 */
  dualWrite: boolean;
  enabledCuts: SovereignCutToggles;
  /** 宪法初始权重（各信号源裁决分量）。 */
  weights: PolicyWeights;
}

/** 默认宪法权重：用户长期走向与北极星权重最高，河床/时空为重要参考，用户当下表达不盲从。 */
export const DEFAULT_POLICY_WEIGHTS: PolicyWeights = {
  userTrajectory: 1.0,
  northStar: 0.95,
  mirror: 0.6, // 初始较低；随镜像精度自增长（mirrorToWeight）
  riverbed: 0.7,
  chronotopic: 0.65,
  truthTier: 0.8,
  userExplicit: 0.75,
};

export const DEFAULT_SOVEREIGN: SovereignConfig = {
  mode: "shadow",
  dualWrite: false,
  enabledCuts: { unify: false, constitution: false, mirror: false, chrono: false, policy: false },
  weights: { ...DEFAULT_POLICY_WEIGHTS },
};

/** 最小只读接口（结构子类型），不反向 import riverMain。 */
export interface MindSovereignReadLike {
  sovereign?: SovereignConfig;
}

function cloneDefault(): SovereignConfig {
  return {
    mode: DEFAULT_SOVEREIGN.mode,
    dualWrite: DEFAULT_SOVEREIGN.dualWrite,
    enabledCuts: { ...DEFAULT_SOVEREIGN.enabledCuts },
    weights: { ...DEFAULT_POLICY_WEIGHTS },
  };
}

function clampWeight(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.min(2, v) : fallback;
}

/** 纯函数：mind 有 sovereign 则规整返回，缺省返回默认深拷贝；绝不修改入参。 */
export function resolveSovereignConfig(mind: MindSovereignReadLike | null | undefined): SovereignConfig {
  const cfg = mind?.sovereign;
  if (!cfg) return cloneDefault();
  const base = cloneDefault();
  const w = cfg.weights ?? {};
  return {
    mode: cfg.mode === "govern" ? "govern" : "shadow",
    dualWrite: cfg.dualWrite === true,
    enabledCuts: {
      unify: cfg.enabledCuts?.unify === true,
      constitution: cfg.enabledCuts?.constitution === true,
      mirror: cfg.enabledCuts?.mirror === true,
      chrono: cfg.enabledCuts?.chrono === true,
      policy: cfg.enabledCuts?.policy === true,
    },
    weights: {
      userTrajectory: clampWeight(w.userTrajectory, base.weights.userTrajectory),
      northStar: clampWeight(w.northStar, base.weights.northStar),
      mirror: clampWeight(w.mirror, base.weights.mirror),
      riverbed: clampWeight(w.riverbed, base.weights.riverbed),
      chronotopic: clampWeight(w.chronotopic, base.weights.chronotopic),
      truthTier: clampWeight(w.truthTier, base.weights.truthTier),
      userExplicit: clampWeight(w.userExplicit, base.weights.userExplicit),
    },
  };
}
