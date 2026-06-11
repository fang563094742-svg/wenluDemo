/**
 * 时空校准层 · 时间维度纯函数（Component 1：chronotopic-time.ts）
 * ------------------------------------------------------------------
 * 把绝对毫秒时间戳确定性地转成「相对节律」——一天中的时段（凌晨/上午/下午/
 * 傍晚/深夜）、一周中的位置、距今时长档位。本模块是整个时空校准层的基底，
 * 被 chronotopic-signature.ts 等上层模块消费。
 *
 * 设计要点（参见 design.md Component 1 与 requirements.md Requirement 1/15）：
 *  - 确定性纯函数：`now` / `target` 一律作为入参（毫秒数）显式传入，
 *    绝不在函数内部读真实时钟、读随机源，便于 fast-check 属性测试。
 *  - `deriveTemporalDimension` 中的 `at` 由入参 `atMs` 转 ISO8601，
 *    属于「依据入参计算」，不违反纯函数约束。
 *
 * 绝对边界（贯穿全时空层，参见 requirements.md Requirement 14）：
 *  - 不 import 任何 3.1 / 3.2 路径的代码、不调其 API、不碰其 sqlite。
 *  - 不 import "server-only"、不 import "node:sqlite"、不用 @/lib 路径别名。
 *  - 纯 TypeScript ESM，相对导入一律带 `.js` 扩展（Node ≥ 22）。本文件无内部依赖。
 */

/**
 * 一天中的时段档（确定性，由本地小时数 0-23 全域划分）。
 *
 * 划分边界（覆盖 0-23 全域，互斥且完备）：
 *  - `late_night`：0-5（凌晨）
 *  - `morning`：6-11（上午）
 *  - `afternoon`：12-17（下午）
 *  - `evening`：18-21（傍晚）
 *  - `night`：22-23（深夜）
 */
export type TimeOfDay = "late_night" | "morning" | "afternoon" | "evening" | "night";

/** 时间维度签名（when）。 */
export interface TemporalDimension {
  /** 事件绝对时间，ISO8601（由入参 atMs 转换得到）。 */
  at: string;
  /** 事件发生时刻的本地小时（0-23），由 atMs + tzOffsetMinutes 确定性推出。 */
  hourOfDay: number;
  /** 时段档（由 hourOfDay 确定性划分）。 */
  timeOfDay: TimeOfDay;
  /** 一周位置（0=周日 .. 6=周六）。 */
  dayOfWeek: number;
  /** 是否周末（dayOfWeek 为 0 或 6）。 */
  isWeekend: boolean;
}

/** 每天的毫秒数。 */
const MS_PER_DAY = 86_400_000;
/** 每小时的毫秒数。 */
const MS_PER_HOUR = 3_600_000;
/** 每分钟的毫秒数。 */
const MS_PER_MINUTE = 60_000;

/**
 * 由本地小时数（0-23）确定性划分时段档。
 *
 * 划分覆盖 0-23 全域、互斥且完备：
 *  late_night 0-5 / morning 6-11 / afternoon 12-17 / evening 18-21 / night 22-23。
 *
 * @param hourOfDay 本地小时（0-23）
 * @returns 对应时段档
 */
function classifyTimeOfDay(hourOfDay: number): TimeOfDay {
  if (hourOfDay <= 5) return "late_night";
  if (hourOfDay <= 11) return "morning";
  if (hourOfDay <= 17) return "afternoon";
  if (hourOfDay <= 21) return "evening";
  return "night";
}

/**
 * 由毫秒时间戳 + 时区偏移，确定性推导时间维度（纯函数，不读时钟）。
 *
 * 推导规则（确定性）：
 *  - 本地毫秒 = atMs + tzOffsetMinutes × 60000。
 *  - `hourOfDay` ∈ [0,23]、`dayOfWeek` ∈ [0,6] 由本地毫秒推出（与 JS UTC 历法对齐：
 *    1970-01-01（epoch）为周四，dayOfWeek=4）。
 *  - `timeOfDay` 由 `hourOfDay` 确定性划分（同 hourOfDay 恒映射同档）。
 *  - `isWeekend` = dayOfWeek 为 0（周日）或 6（周六）。
 *  - `at` 由原始 `atMs`（UTC 绝对时刻）转 ISO8601，不受时区偏移影响。
 *
 * @param atMs 事件绝对时间（毫秒时间戳，应 ≥ 0）
 * @param tzOffsetMinutes 时区偏移（分钟，东区为正，如东八区 +480）
 * @returns 确定性推导出的时间维度
 */
export function deriveTemporalDimension(atMs: number, tzOffsetMinutes: number): TemporalDimension {
  // 本地视角的毫秒数：把 UTC 戳平移到目标时区的「墙上时间」。
  const localMs = atMs + tzOffsetMinutes * MS_PER_MINUTE;

  // 本地小时：对一天取模后除以小时毫秒。用 floorMod 保证负数 localMs 也落在 [0,23]。
  const msIntoDay = floorMod(localMs, MS_PER_DAY);
  const hourOfDay = Math.floor(msIntoDay / MS_PER_HOUR);

  // 一周位置：epoch（1970-01-01）为周四 → 偏移 4，再对 7 取 floorMod 落在 [0,6]。
  const daysSinceEpoch = Math.floor(localMs / MS_PER_DAY);
  const dayOfWeek = floorMod(daysSinceEpoch + 4, 7);

  return {
    at: new Date(atMs).toISOString(),
    hourOfDay,
    timeOfDay: classifyTimeOfDay(hourOfDay),
    dayOfWeek,
    isWeekend: dayOfWeek === 0 || dayOfWeek === 6,
  };
}

/**
 * 距今时长（毫秒），= max(0, nowMs - targetMs)。
 *
 * 未来事件（targetMs > nowMs）按「此刻」处理，钳为 0；targetMs == nowMs 亦为 0；
 * 过去事件返回正差值。纯函数，不读时钟。
 *
 * @param targetMs 目标事件的毫秒时间戳
 * @param nowMs 当前参考时刻的毫秒时间戳
 * @returns 非负的距今毫秒数
 */
export function ageMs(targetMs: number, nowMs: number): number {
  return Math.max(0, nowMs - targetMs);
}

/**
 * 取模并保证结果非负（floored modulo）。
 *
 * JS 原生 `%` 对负被除数返回负余数（如 -1 % 7 === -1）；本函数把结果折回 [0, m)，
 * 从而让负的本地毫秒（极端时区偏移）也能映射到合法的小时 / 周位置。
 *
 * @param n 被除数
 * @param m 模数（应 > 0）
 * @returns 位于 [0, m) 的非负余数
 */
function floorMod(n: number, m: number): number {
  return ((n % m) + m) % m;
}
