/**
 * 问路 — 平台值归一（skill-reflux Req 1.2 / 1.4）。
 *
 * 统一平台枚举对齐 skill-flywheel 的 `SkillPlatform = "mac" | "win" | "linux" | "any"`，
 * **不使用** Node `process.platform` 的 `win32` / `darwin` 等历史值。
 *
 * 双重保证（与 006_skill_reflux.sql 配套）：
 *  - 迁移侧：006 在写入新约束前把库内既有旧值 win32→win、darwin→mac 归一；
 *  - 读路径侧：凡从库/连接器/外部读到平台值，统一经此处归一后再使用，
 *    防止任何遗漏或新流入的旧值绕过约束。
 */

/** 统一后的平台枚举（与 skill-flywheel SkillPlatform 对齐）。 */
export type NormalizedPlatform = "mac" | "win" | "linux" | "any";

/** 可执行变体的平台枚举（不含 any）。 */
export type VariantOs = "mac" | "win" | "linux";

/** 旧平台值 → 统一值的映射表。 */
const PLATFORM_ALIASES: Record<string, NormalizedPlatform> = {
  win32: "win",
  windows: "win",
  win: "win",
  darwin: "mac",
  macos: "mac",
  osx: "mac",
  mac: "mac",
  linux: "linux",
  any: "any",
};

/**
 * 把任意来源的平台字符串归一为统一枚举；无法识别时返回 'any'（最宽松、不丢可用性）。
 * 大小写不敏感，两端空白忽略。
 */
export function normalizePlatform(value: string | null | undefined): NormalizedPlatform {
  if (!value) return "any";
  const key = value.trim().toLowerCase();
  return PLATFORM_ALIASES[key] ?? "any";
}

/**
 * 归一为可执行变体平台（mac/win/linux）；'any' 或无法识别时返回 null
 * （可执行变体必须落到具体平台，不能是 any）。
 */
export function normalizeVariantOs(value: string | null | undefined): VariantOs | null {
  const p = normalizePlatform(value);
  return p === "any" ? null : p;
}

/** 归一平台数组：逐项归一并去重；空输入返回 ['any']。 */
export function normalizePlatformList(
  values: readonly (string | null | undefined)[] | null | undefined,
): NormalizedPlatform[] {
  if (!values || values.length === 0) return ["any"];
  const seen = new Set<NormalizedPlatform>();
  for (const v of values) seen.add(normalizePlatform(v));
  return [...seen];
}
