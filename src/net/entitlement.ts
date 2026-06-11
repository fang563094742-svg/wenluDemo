/**
 * 出网授权（Egress Entitlement）· 多用户判断门控
 * ------------------------------------------------------------------
 * 第一性原理：境外出口是稀缺 / 敏感资源，多用户下"不是所有用户都有"。
 * 是否放行境外出口（proxy 出口）必须由"判断内容"逐用户裁定，而非全局开关。
 *
 * 授权 = 订阅门槛 ∩ 河床判断：
 *   - 订阅门槛：付费用户（或套餐 features.overseas_egress 显式开启）。
 *   - 河床判断：该用户河床 D11_RESOURCE（资源域）存在一条 verdict ≠ "block" 的判断，
 *     代表系统已判断该用户确有联网深度需求且未被风险阻断。
 *   - 二者同时满足才放行境外出口；否则只给国内直连（direct / doh-direct）。
 *
 * 本模块为纯函数（无 DB import、无网络、无时钟），调用方把已取到的信号传进来，
 * 便于单测且与 SessionManager / subscriptionRepo 解耦（不反向依赖）。
 *
 * 沿用弟弟 ESM 约定：相对导入带 `.js` 扩展。
 */

/** 河床节点的最小读取形状（只取门控需要的字段，避免依赖河床完整类型）。 */
export interface EntitlementRiverbedNodeLike {
  /** 14 域之一；门控只关心 D11_RESOURCE。 */
  domain: string;
  /** 否决级别；"block" 视为被风险阻断。 */
  verdict: string;
  /** 判断置信度 ∈ [0,1]。 */
  confidence: number;
}

/** 解析出网授权所需的逐用户信号。 */
export interface EntitlementInput {
  /** 用户标识（仅用于留痕 / 诊断）。 */
  userId: string;
  /** 是否付费用户（来自 subscriptionRepo.isPaidUser 或套餐判定）。 */
  isPaidUser: boolean;
  /** 套餐 features.overseas_egress 是否显式开启（优先于 isPaidUser 的硬开关）。 */
  planAllowsOverseas?: boolean;
  /** 该用户河床节点（门控只扫 D11_RESOURCE）。 */
  riverbedNodes?: readonly EntitlementRiverbedNodeLike[];
  /** 河床判断的最低置信度门槛，默认 0.5。 */
  minResourceConfidence?: number;
}

/** 出网授权结果：netEgress 据此决定是否启用 proxy 出口。 */
export interface EgressEntitlement {
  /** 用户标识。 */
  userId: string;
  /** 是否放行境外出口（proxy 出口）。 */
  allowOverseas: boolean;
  /** 裁定理由（人类可读，用于留痕 / 诊断 / 渲染回意识）。 */
  reason: string;
}

const DEFAULT_MIN_RESOURCE_CONFIDENCE = 0.5;
const RESOURCE_DOMAIN = "D11_RESOURCE";

/**
 * 解析逐用户出网授权（纯函数）。
 *
 * 判定（任一不满足即 allowOverseas=false，降级国内直连）：
 *   1. 订阅门槛：planAllowsOverseas === true 或 isPaidUser === true。
 *   2. 河床判断：D11_RESOURCE 域存在一条 verdict ≠ "block" 且 confidence ≥ 门槛的判断。
 *
 * @param input 逐用户信号
 * @returns 出网授权结果
 */
export function resolveEgressEntitlement(input: EntitlementInput): EgressEntitlement {
  const minConf = input.minResourceConfidence ?? DEFAULT_MIN_RESOURCE_CONFIDENCE;

  // ① 订阅门槛。
  const subscriptionOk = input.planAllowsOverseas === true || input.isPaidUser === true;
  if (!subscriptionOk) {
    return {
      userId: input.userId,
      allowOverseas: false,
      reason: "订阅未达门槛（非付费且套餐未开启 overseas_egress）→ 仅国内直连",
    };
  }

  // ② 河床判断：D11 资源域需有未被阻断、置信度达标的判断内容。
  const nodes = input.riverbedNodes ?? [];
  const qualified = nodes.find(
    (n) =>
      n.domain === RESOURCE_DOMAIN &&
      n.verdict !== "block" &&
      Number.isFinite(n.confidence) &&
      n.confidence >= minConf,
  );

  if (!qualified) {
    return {
      userId: input.userId,
      allowOverseas: false,
      reason: `订阅达标，但河床 ${RESOURCE_DOMAIN} 无合格判断内容（需 verdict≠block 且 confidence≥${minConf}）→ 仅国内直连`,
    };
  }

  return {
    userId: input.userId,
    allowOverseas: true,
    reason: `订阅达标 + 河床 ${RESOURCE_DOMAIN} 有合格判断（confidence=${qualified.confidence.toFixed(2)}）→ 放行境外出口`,
  };
}

/**
 * 单用户 / 本机默认授权：在尚未接入多用户订阅前，单实例运行用本机配置直接放行。
 * 多用户接入后改用 `resolveEgressEntitlement`。
 *
 * @param userId 用户标识，默认 "local"
 * @param allowOverseas 本机是否配置了境外出口，默认 false（无出口则只国内直连）
 */
export function localEgressEntitlement(
  userId = "local",
  allowOverseas = false,
): EgressEntitlement {
  return {
    userId,
    allowOverseas,
    reason: allowOverseas
      ? "本机单实例：已配置境外出口，放行"
      : "本机单实例：未配置境外出口，仅国内直连",
  };
}
