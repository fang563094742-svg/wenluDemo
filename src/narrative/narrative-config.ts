/**
 * 叙事输出层 · 配置与默认模块（Component 6：narrative-config.ts）
 * ------------------------------------------------------------------
 * 定义叙事层的可选轻量配置 `NarrativeVoiceConfig`、常量默认
 * `DEFAULT_NARRATIVE_VOICE`，以及从 mind 读取配置、缺省回退默认的确定性纯函数
 * `resolveNarrativeConfig`。配置走 mind 顶层【单个】可选字段 `narrativeVoice?`，
 * mind 无该字段时回退常量默认（向后兼容、零行为改变）。
 *
 * 设计要点（参见 design.md Component 6 与 requirements.md R6 / R9.4 / R9.5）：
 *  - `DEFAULT_NARRATIVE_VOICE` 默认 `mode="dry-run"`，使缺省接入零行为改变。
 *  - 所有数值落在各自合法值域内：阈值 ∈ [0,1]，lateBoost ∈ [0,2]。
 *  - `resolveNarrativeConfig` 为确定性纯函数：含 `narrativeVoice` 则返回该配置，
 *    缺省返回 `DEFAULT_NARRATIVE_VOICE` 的深拷贝；不修改入参 mind、无副作用。
 *
 * 绝对边界（贯穿全叙事层，参见 requirements.md Requirement 9）：
 *  - 不 import 任何 3.1 / 3.2 路径的代码、不调其 API、不碰其 sqlite。
 *  - 不 import "server-only"、不 import "node:sqlite"、不用 @/lib 路径别名。
 *  - 不反向 import `riverMain.ts`（经 `MindReadLike` 风格的最小只读接口解耦）。
 *  - 纯 TypeScript ESM，相对导入一律带 `.js` 扩展（Node ≥ 22）。
 */

/**
 * 叙事层工作模式。
 *  - `dry-run`：观察模式（默认）。只观察记录、零行为改变，裁决仅取 `pass` / `annotate`。
 *  - `enforce`：显式启用裁决的工作模式，仍降级安全（fail-open）。
 */
export type NarrativeMode = "dry-run" | "enforce";

/**
 * 叙事层 mind 只读最小接口的统一出口。
 *
 * `MindReadLike` 的**唯一定义**在本模块（下方 interface），叙事层各组件共享的单一来源。
 * （历史上曾尝试从 narrative-source re-export，与本地定义重名冲突，已移除该 re-export。）
 */

/**
 * 渲染标注模式。
 *  - `off`：原样返回原文（最忠实、零增改语义，默认）。
 *  - `inline-tier`：对由未验证来源支撑的断言追加轻量分层提示，不改原断言语义。
 *  - `footnote`：文末追加来源脚注，不改原断言语义。
 */
export type NarrativeAnnotateMode = "off" | "inline-tier" | "footnote";

/**
 * 叙事层可选轻量配置。
 *
 * 挂在 mind 顶层 `narrativeVoice?` 字段；缺省即用 {@link DEFAULT_NARRATIVE_VOICE}。
 */
export interface NarrativeVoiceConfig {
  /** 工作模式：dry-run（观察，默认，零行为改变）/ enforce（启用裁决）。 */
  mode: NarrativeMode;
  /** 忠实度放行阈值 ∈ [0,1]（默认 0.6）。 */
  passThreshold: number;
  /** 单断言判定「受支撑」的支撑度阈值 ∈ [0,1]（默认 0.34）。 */
  supportThreshold: number;
  /** 长输出后段加重系数 ∈ [0,2]（默认 0.5）。 */
  lateBoost: number;
  /** 渲染标注模式（默认 off）。 */
  annotateMode: NarrativeAnnotateMode;
  /** 人格禁用模式扩展词表（与内置词表合并使用，不替换）。 */
  extraForbiddenPatterns: string[];
}

/**
 * 常量默认（mind 无 `narrativeVoice` 字段时使用，向后兼容、最保守）。
 *
 * 各数值落在合法值域内：阈值 ∈ [0,1]，lateBoost ∈ [0,2]。
 * 默认 `mode="dry-run"`、`annotateMode="off"`，使缺省接入对既有行为零改变。
 */
export const DEFAULT_NARRATIVE_VOICE: NarrativeVoiceConfig = {
  mode: "dry-run",
  passThreshold: 0.6,
  supportThreshold: 0.34,
  lateBoost: 0.5,
  annotateMode: "off",
  extraForbiddenPatterns: [],
};

/**
 * 叙事层读取【配置】所需的 mind 最小只读接口。
 *
 * 完整 Mind 与 {@link MindReadLike} 天然满足此结构子类型；叙事层不反向
 * import `riverMain.ts`，仅通过该最小接口解耦读取配置。
 */
export interface MindConfigReadLike {
  /** 可选叙事层配置；缺省即回退 {@link DEFAULT_NARRATIVE_VOICE}。 */
  narrativeVoice?: NarrativeVoiceConfig;
}

/**
 * 叙事层读取 mind 所需字段的最小只读接口（解耦核心，参见 design.md Data Models）。
 *
 * 完整 Mind 天然满足此结构子类型；叙事层【只】通过该只读接口依赖 mind，
 * **不反向 import `riverMain.ts`**，杜绝循环依赖。所有可选字段缺省时按空处理、
 * 绝不抛错（降级安全）。`riverbed` / `chronotopic` 以 `unknown` 接入，由
 * narrative-source 的窄化读取器安全消费（结构不符即跳过该来源）。
 *
 * 该接口在此（config 模块）定义并导出，作为叙事层各组件共享的单一来源。
 */
export interface MindReadLike extends MindConfigReadLike {
  /** 判断（带 source/confidence）；`correctedBy` 已设者为被推翻、不转述。 */
  beliefs: ReadonlyArray<{
    id: string;
    content: string;
    confidence: number;
    source: string;
    correctedBy?: string;
  }>;
  /** 知识（带 source）。 */
  knowledge: ReadonlyArray<{ content: string; source: string }>;
  /** 用户洞察；`supersededBy` 已设者为被取代、不转述。 */
  userModel: ReadonlyArray<{
    id: string;
    aspect: string;
    content: string;
    confidence: number;
    supersededBy?: string;
  }>;
  /** 河床判断（窄化安全读取，不依赖河床内部类型）。 */
  riverbed?: unknown;
  /** 时空签名（窄化安全读取，不依赖时空内部类型）。 */
  chronotopic?: unknown;
  /** 既有军法禁用模式数据源（人格门复用，不另立标准）。 */
  fallbackReplyPolicy?: { legacyPatterns: string[] };
}

/**
 * 从 mind 读取叙事层配置，缺省回退常量默认（确定性纯函数，不修改入参 mind）。
 *
 * - mind 含 `narrativeVoice` 字段 → 返回该配置。
 * - mind 缺省 `narrativeVoice` → 返回 {@link DEFAULT_NARRATIVE_VOICE} 的深拷贝
 *   （避免调用方拿到对常量的引用进而意外改写共享默认）。
 *
 * @param mind 只读最小 mind 接口。
 * @returns 解析后的 {@link NarrativeVoiceConfig}。
 */
export function resolveNarrativeConfig(
  mind: MindConfigReadLike,
): NarrativeVoiceConfig {
  if (mind.narrativeVoice !== undefined) {
    return mind.narrativeVoice;
  }
  return cloneDefaultNarrativeVoice();
}

/**
 * 返回 {@link DEFAULT_NARRATIVE_VOICE} 的深拷贝。
 *
 * 优先用 `structuredClone`（Node ≥ 17 全局可用）；理论上不可用时手动展开兜底，
 * 确保 `extraForbiddenPatterns` 数组亦为新引用，不与常量共享可变状态。
 */
function cloneDefaultNarrativeVoice(): NarrativeVoiceConfig {
  if (typeof structuredClone === "function") {
    return structuredClone(DEFAULT_NARRATIVE_VOICE);
  }
  return {
    ...DEFAULT_NARRATIVE_VOICE,
    extraForbiddenPatterns: [...DEFAULT_NARRATIVE_VOICE.extraForbiddenPatterns],
  };
}
