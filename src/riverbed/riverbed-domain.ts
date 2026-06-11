/**
 * 河床系统 · 14 域注册表（Domain Registry）
 * ------------------------------------------------------------------
 * 这是河床 14 个人生领域（D0_ASPIRATION … D13_VALUE）的唯一真相源。
 * 直接重写自 3.1 蓝本，但完全长进弟弟自己的代码主链：
 *  - 去掉 3.1 的 `phaseIntroduced` 字段（弟弟无阶段概念）。
 *  - 保留 `canTriggerEngine: false` 不变量——河床永不触发引擎。
 *  - label 一律用中文，贴合弟弟的中文人格。
 *
 * 绝对边界（requirements.md Requirement 14）：
 *  - 不 import 任何 3.1 / 3.2 路径的代码。
 *  - 不 import `node:sqlite`、不写 `import "server-only"`、不用 `@/lib/` 别名。
 *  - 纯 TypeScript ESM，相对导入带 `.js` 扩展（本文件无相对导入）。
 *
 * 对应需求：1.1（恰 14 域、id 唯一、index 0..13 连续）、1.2（每域字段齐备）、
 *          1.3（assertRiverbedDomainRegistryIntegrity）、1.4（isRiverbedDomainId）。
 */

/**
 * 14 个人生领域的 ID 元组（唯一真相源）。
 * 顺序即 index：D0 在 index 0，D13 在 index 13，恰好 14 个、连续、唯一。
 */
export const RIVERBED_DOMAIN_IDS = [
  "D0_ASPIRATION",
  "D1_IDENTITY",
  "D2_GOAL",
  "D3_DECISION",
  "D4_BEHAVIOR",
  "D5_EXECUTION",
  "D6_FAILURE",
  "D7_ENERGY",
  "D8_EMOTION",
  "D9_COGNITION",
  "D10_RELATIONSHIP",
  "D11_RESOURCE",
  "D12_OPPORTUNITY_ENVIRONMENT",
  "D13_VALUE",
] as const;

/** 14 域之一的领域标识符（由 `RIVERBED_DOMAIN_IDS` 元组派生）。 */
export type RiverbedDomainId = (typeof RIVERBED_DOMAIN_IDS)[number];

/** 领域的语义类型（与 14 个 id 一一对应的小写英文枚举）。 */
export type RiverbedDomainType =
  | "aspiration"
  | "identity"
  | "goal"
  | "decision"
  | "behavior"
  | "execution"
  | "failure"
  | "energy"
  | "emotion"
  | "cognition"
  | "relationship"
  | "resource"
  | "opportunity_environment"
  | "value";

/**
 * 一条领域注册项。
 * `canTriggerEngine` 字面量类型恒为 `false`——在类型层钉死"河床永不触发引擎"。
 */
export interface RiverbedDomainEntry {
  /** 领域标识符（14 域之一）。 */
  id: RiverbedDomainId;
  /** 领域在注册表中的位序，范围 0..13，连续。 */
  index: number;
  /** 领域语义类型。 */
  type: RiverbedDomainType;
  /** 中文标签——贴合弟弟的中文人格。 */
  label: string;
  /** 该领域判断什么（中文描述）。 */
  description: string;
  /** 不变量：河床判断永不驱动执行。 */
  canTriggerEngine: false;
}

/**
 * 14 域注册表（中文 label）。
 * 顺序与 `RIVERBED_DOMAIN_IDS` 严格一致，index 即数组下标。
 */
export const RIVERBED_DOMAIN_REGISTRY: readonly RiverbedDomainEntry[] = [
  {
    id: "D0_ASPIRATION",
    index: 0,
    type: "aspiration",
    label: "志向",
    description: "长程志向与方向性的牵引力。",
    canTriggerEngine: false,
  },
  {
    id: "D1_IDENTITY",
    index: 1,
    type: "identity",
    label: "身份",
    description: "自我定义与身份认同的一致性。",
    canTriggerEngine: false,
  },
  {
    id: "D2_GOAL",
    index: 2,
    type: "goal",
    label: "目标",
    description: "目标的清晰度与契合度。",
    canTriggerEngine: false,
  },
  {
    id: "D3_DECISION",
    index: 3,
    type: "decision",
    label: "决策",
    description: "决策质量与约束就绪度。",
    canTriggerEngine: false,
  },
  {
    id: "D4_BEHAVIOR",
    index: 4,
    type: "behavior",
    label: "行为",
    description: "行为模式与行动倾向。",
    canTriggerEngine: false,
  },
  {
    id: "D5_EXECUTION",
    index: 5,
    type: "execution",
    label: "执行",
    description: "执行就绪度与操作层摩擦。",
    canTriggerEngine: false,
  },
  {
    id: "D6_FAILURE",
    index: 6,
    type: "failure",
    label: "失败",
    description: "失败模式与恢复信号。",
    canTriggerEngine: false,
  },
  {
    id: "D7_ENERGY",
    index: 7,
    type: "energy",
    label: "能量",
    description: "能量、容量与节奏。",
    canTriggerEngine: false,
  },
  {
    id: "D8_EMOTION",
    index: 8,
    type: "emotion",
    label: "情绪",
    description: "情绪基调与情感负荷。",
    canTriggerEngine: false,
  },
  {
    id: "D9_COGNITION",
    index: 9,
    type: "cognition",
    label: "认知",
    description: "认知框架与推理质量。",
    canTriggerEngine: false,
  },
  {
    id: "D10_RELATIONSHIP",
    index: 10,
    type: "relationship",
    label: "关系",
    description: "关系情境与人际边界。",
    canTriggerEngine: false,
  },
  {
    id: "D11_RESOURCE",
    index: 11,
    type: "resource",
    label: "资源",
    description: "资源约束与可获得的支持。",
    canTriggerEngine: false,
  },
  {
    id: "D12_OPPORTUNITY_ENVIRONMENT",
    index: 12,
    type: "opportunity_environment",
    label: "机会环境",
    description: "外部机会与环境契合度。",
    canTriggerEngine: false,
  },
  {
    id: "D13_VALUE",
    index: 13,
    type: "value",
    label: "价值",
    description: "价值对齐与主权约束。",
    canTriggerEngine: false,
  },
] as const;

/**
 * 判断一个字符串是否为合法的 RiverbedDomainId（类型守卫）。
 *
 * @param value 任意字符串
 * @returns 该字符串是否为 14 域之一
 */
export function isRiverbedDomainId(value: string): value is RiverbedDomainId {
  return (RIVERBED_DOMAIN_IDS as readonly string[]).includes(value);
}

/**
 * 取得某领域的注册项。
 *
 * @param domain 领域标识符
 * @returns 对应的 RiverbedDomainEntry；未知 id 返回 null
 */
export function getRiverbedDomainEntry(
  domain: RiverbedDomainId,
): RiverbedDomainEntry | null {
  return RIVERBED_DOMAIN_REGISTRY.find((entry) => entry.id === domain) ?? null;
}

/**
 * 校验 14 域注册表完整性：
 *  - 恰好 14 个领域；
 *  - 所有 id 唯一；
 *  - index 从 0 到 13 连续（不缺、不重、不越界）。
 *
 * 任一条件不满足即抛错；全部满足时返回 true。
 *
 * @returns 校验通过时恒为 true
 * @throws 注册表数量错、id 重复或 index 不连续时抛错
 */
export function assertRiverbedDomainRegistryIntegrity(): true {
  const registry = RIVERBED_DOMAIN_REGISTRY;

  if (registry.length !== 14) {
    throw new Error("RIVERBED_DOMAIN_REGISTRY_MUST_HAVE_14_DOMAINS");
  }

  const ids = registry.map((entry) => entry.id);
  const uniqueIds = new Set(ids);
  if (uniqueIds.size !== ids.length) {
    throw new Error("RIVERBED_DOMAIN_REGISTRY_DUPLICATE_ID");
  }

  const indices = registry.map((entry) => entry.index).sort((a, b) => a - b);
  for (let i = 0; i < indices.length; i += 1) {
    if (indices[i] !== i) {
      throw new Error("RIVERBED_DOMAIN_REGISTRY_INDEX_NOT_CONTIGUOUS");
    }
  }

  return true;
}
