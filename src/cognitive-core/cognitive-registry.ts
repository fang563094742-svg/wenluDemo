/**
 * 认知核三段脊柱 · 输出类型注册表（Component 4：cognitive-registry.ts）
 * ------------------------------------------------------------------
 * 定义输出类型描述符 `OutputTypeDescriptor`、注册表 `OutputTypeRegistry`
 * 接口与其默认实现 `DefaultOutputTypeRegistry`，以及默认 registry 工厂
 * `createDefaultOutputTypeRegistry`。让新输出类型可通过 `register` 挂插件
 * 扩展，而不动主链代码（参见 design.md Component 4「Registry 扩展点」）。
 *
 * 设计要点（参见 design.md Component 4 与「最高约束章·约束 3」）：
 *  - `Intent` / `Output` 是带 schema 的一等公民；输出类型经 registry 解析。
 *  - 默认注册 5 种蓝本类型（content / product / relationship_action /
 *    decision / asset），复用 `types.ts` 的 `WenluOutputType`，不重复定义。
 *  - 新类型 = 往 registry 挂插件（`register`），随后即可被 `resolve` 解析；
 *    `knownTypes()` 默认含上述 5 种。工厂支持外部扩展不动主链。
 *
 * 绝对边界（贯穿全认知核，参见 design.md「最高约束章·约束 4」）：
 *  - 不 import 任何 3.1 / 3.2 路径的代码、不调其 API、不碰其 sqlite。
 *  - 不 import "server-only"、不 import "node:sqlite"、不用 @/lib 路径别名。
 *  - 不反向 import `riverMain.ts`。
 *  - 纯 TypeScript ESM，相对导入一律带 `.js` 扩展（Node ≥ 22）。
 *  - 零第三方运行时依赖。
 */

import type { OutputAudience, WenluOutputType } from "./types.js";

/**
 * 输出类型描述符：描述一种输出类型的元信息，供呈现 / 受众调度参考。
 */
export interface OutputTypeDescriptor {
  /** 人类可读名（用于调试 / 观察，非外溢文本）。 */
  label: string;
  /**
   * 该类型的默认受众（可选）。
   * 缺省时由输出核按上下文裁决（一般落 "user"）。
   */
  defaultAudience?: OutputAudience;
  /** 该类型的可选描述（用途说明）。 */
  description?: string;
}

/**
 * 输出类型注册表：让新输出类型可挂插件扩展，而不动主链。
 *
 * - `register`：注册（或覆盖）一种输出类型的描述符。
 * - `resolve`：解析类型描述符；未注册返回 `undefined`。
 * - `knownTypes`：返回当前已知的全部类型名（默认含 5 种蓝本类型）。
 */
export interface OutputTypeRegistry {
  /**
   * 注册（或覆盖）一种输出类型。
   * @param type 类型名（蓝本 5 种之一，或扩展的新类型字符串）。
   * @param descriptor 该类型的描述符。
   */
  register(type: string, descriptor: OutputTypeDescriptor): void;
  /**
   * 解析类型描述符。
   * @param type 类型名。
   * @returns 已注册返回描述符，否则返回 `undefined`。
   */
  resolve(type: string): OutputTypeDescriptor | undefined;
  /**
   * 返回当前已知的全部类型名（确定性顺序，默认含 5 种蓝本类型）。
   */
  knownTypes(): ReadonlyArray<string>;
}

/**
 * 5 种蓝本输出类型的默认描述符（借鉴 3.1 蓝本，只读参考、不 import）。
 *
 * 键为 `WenluOutputType`，保证与 `types.ts` 的枚举一一对应、不漏不多。
 */
const BLUEPRINT_DESCRIPTORS: Readonly<
  Record<WenluOutputType, OutputTypeDescriptor>
> = {
  content: {
    label: "内容",
    defaultAudience: "user",
    description: "信息 / 解释 / 汇报。",
  },
  product: {
    label: "产物",
    defaultAudience: "user",
    description: "做成的产物。",
  },
  relationship_action: {
    label: "关系动作",
    defaultAudience: "user",
    description: "关系动作（关心 / 对齐 / 确认）。",
  },
  decision: {
    label: "决策点",
    defaultAudience: "user",
    description: "需用户拍板的决策点。",
  },
  asset: {
    label: "资产",
    defaultAudience: "internal",
    description: "沉淀资产（能力 / 知识 / 规则）。",
  },
};

/**
 * {@link OutputTypeRegistry} 的默认实现。
 *
 * 构造时默认注册 5 种蓝本类型；`register` 支持挂插件扩展（含覆盖既有类型）。
 * 内部以 `Map` 维护，`knownTypes` 按插入顺序返回（蓝本 5 种在前，确定性）。
 */
export class DefaultOutputTypeRegistry implements OutputTypeRegistry {
  private readonly descriptors = new Map<string, OutputTypeDescriptor>();

  /**
   * @param seed 可选：在 5 种蓝本类型之上追加的扩展类型（挂插件，不动主链）。
   */
  constructor(seed?: Readonly<Record<string, OutputTypeDescriptor>>) {
    // 先注册 5 种蓝本类型（确定性顺序）。
    for (const type of Object.keys(
      BLUEPRINT_DESCRIPTORS,
    ) as ReadonlyArray<WenluOutputType>) {
      this.register(type, { ...BLUEPRINT_DESCRIPTORS[type] });
    }
    // 再注册外部扩展（可覆盖蓝本默认）。
    if (seed !== undefined) {
      for (const [type, descriptor] of Object.entries(seed)) {
        this.register(type, { ...descriptor });
      }
    }
  }

  register(type: string, descriptor: OutputTypeDescriptor): void {
    this.descriptors.set(type, descriptor);
  }

  resolve(type: string): OutputTypeDescriptor | undefined {
    return this.descriptors.get(type);
  }

  knownTypes(): ReadonlyArray<string> {
    return Array.from(this.descriptors.keys());
  }
}

/**
 * 默认 registry 工厂：返回一个已注册 5 种蓝本类型的注册表。
 *
 * 支持通过 `seed` 挂插件扩展新类型而不动主链（参见 design.md「约束 3」）。
 *
 * @param seed 可选扩展类型映射（在 5 种蓝本之上追加 / 覆盖）。
 * @returns 全新的 {@link OutputTypeRegistry} 实例（互不共享可变状态）。
 */
export function createDefaultOutputTypeRegistry(
  seed?: Readonly<Record<string, OutputTypeDescriptor>>,
): OutputTypeRegistry {
  return new DefaultOutputTypeRegistry(seed);
}
