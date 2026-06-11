/**
 * 时空校准层 · 意识注入模块（Component 5：chronotopic-render.ts）
 * ------------------------------------------------------------------
 * 把一组活跃时空签名（ChronotopicSignature）渲染成 `buildConsciousness` 能注入
 * system prompt 的中文纯文本块——「此刻时空态势」。弟弟在每个呼吸周期都能据此
 * 感知"我此刻处在什么时间、什么场景、用户在不在场"。
 *
 * 职责（design.md Component 5 + requirements.md Requirement 5）：
 *   - 5.1 接收一组活跃签名与 `nowMs`，返回描述「此刻时空态势」的中文文本块。
 *   - 5.2 签名列表为空 → 返回固定占位串「（时空感尚在形成）」，不破坏既有意识结构。
 *   - 5.4 仅依据入参渲染：不修改签名列表（排序前先拷贝）、不读系统时钟（用入参 nowMs）。
 *
 * 输出有合理字符上限（防 token 膨胀），超长截断并追加省略标记。
 *
 * 绝对边界（requirements.md Requirement 14）：
 *   - 不 import 任何 3.1 / 3.2 路径的代码、不调其 API、不碰其 sqlite。
 *   - 不 import "server-only"、不 import "node:sqlite"、不用 @/lib 路径别名。
 *   - 纯 TypeScript ESM，相对导入一律带 `.js` 扩展。确定性纯函数，无副作用。
 *
 * _Requirements: 5.1, 5.2, 5.4_
 */

import type { TimeOfDay } from "./chronotopic-time.js";
import { ageMs } from "./chronotopic-time.js";
import type {
  ChronotopicSignature,
  ChronotopicScene,
  ChronotopicPresence,
} from "./chronotopic-signature.js";

/** 空签名列表的固定中文占位串（Requirement 5.2）。 */
const EMPTY_PLACEHOLDER = "（时空感尚在形成）";

/** 时空态势块标题。 */
const BLOCK_HEADER = "== 此刻时空态势 ==";

/** 渲染输出的默认字符上限（防 token 膨胀）。 */
const DEFAULT_MAX_CHARS = 1200;

/** 最近签名摘要默认列出条数上限。 */
const DEFAULT_RECENT_N = 6;

/** 超长截断时追加的省略标记。 */
const TRUNCATION_MARK = "…（已截断）";

/** 时段档（when）中文化映射。 */
const TIME_OF_DAY_LABEL: Record<TimeOfDay, string> = {
  late_night: "深夜",
  morning: "上午",
  afternoon: "下午",
  evening: "傍晚",
  night: "夜晚",
};

/** 场景档（where）中文化映射。 */
const SCENE_LABEL: Record<ChronotopicScene, string> = {
  coding: "编码",
  meeting: "会议",
  browsing: "浏览",
  writing: "写作",
  communication: "沟通",
  idle: "空闲",
  unknown: "未知",
};

/** 在场档（presence）中文化映射。 */
const PRESENCE_LABEL: Record<ChronotopicPresence, string> = {
  present: "在场",
  recently_active: "刚离开",
  away: "已离开",
};

/** 一周位置（0=周日 .. 6=周六）中文化映射。 */
const DAY_OF_WEEK_LABEL = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/**
 * 时段档中文化（未知值回退原值，绝不崩溃）。
 */
function timeOfDayLabel(timeOfDay: TimeOfDay): string {
  return TIME_OF_DAY_LABEL[timeOfDay] ?? String(timeOfDay);
}

/**
 * 场景档中文化（未知值回退原值，绝不崩溃）。
 */
function sceneLabel(scene: ChronotopicScene): string {
  return SCENE_LABEL[scene] ?? String(scene);
}

/**
 * 在场档中文化（未知值回退原值，绝不崩溃）。
 */
function presenceLabel(presence: ChronotopicPresence): string {
  return PRESENCE_LABEL[presence] ?? String(presence);
}

/**
 * 一周位置中文化（越界回退原值，绝不崩溃）。
 */
function dayOfWeekLabel(dayOfWeek: number): string {
  return DAY_OF_WEEK_LABEL[dayOfWeek] ?? String(dayOfWeek);
}

/**
 * 把一条签名渲染成时段 + 场景 + 在场 + 前台应用的简洁中文摘要。
 * 形如：`周四下午·编码·在场·VSCode`。前台应用缺失时省略该段。
 */
function renderSignatureSummary(sig: ChronotopicSignature): string {
  const segments: string[] = [
    `${dayOfWeekLabel(sig.temporal.dayOfWeek)}${timeOfDayLabel(sig.temporal.timeOfDay)}`,
    sceneLabel(sig.scene),
    presenceLabel(sig.presence),
  ];

  const appName = sig.frontAppName?.trim();
  if (appName) segments.push(appName);

  return segments.join("·");
}

/**
 * 取「此刻」签名——签名构建时刻（createdAt）距 nowMs 最近的那一条。
 *
 * 解析失败（NaN）的 createdAt 视为最久远（age 取 +Infinity），保证不被错误选作最新。
 * 不修改入参（基于拷贝比较），相同入参确定性返回。
 *
 * @param signatures 非空签名列表（只读）
 * @param nowMs 当前参考时刻
 * @returns 距 nowMs 最近的签名
 */
function pickCurrentSignature(
  signatures: readonly ChronotopicSignature[],
  nowMs: number,
): ChronotopicSignature {
  const signatureAge = (sig: ChronotopicSignature): number => {
    const createdMs = Date.parse(sig.createdAt);
    return Number.isNaN(createdMs) ? Number.POSITIVE_INFINITY : ageMs(createdMs, nowMs);
  };

  let current = signatures[0];
  let currentAge = signatureAge(current);
  for (let i = 1; i < signatures.length; i++) {
    const candidateAge = signatureAge(signatures[i]);
    if (candidateAge < currentAge) {
      current = signatures[i];
      currentAge = candidateAge;
    }
  }
  return current;
}

/**
 * 把一组活跃时空签名渲染成中文「此刻时空态势」文本块（喂进 `buildConsciousness`）。
 *
 * 算法（design.md Component 5 + Requirement 5）：
 *   1. maxChars ≤ 0 → 返回空串（防越界）。
 *   2. 空签名列表 → 返回固定占位串「（时空感尚在形成）」（Requirement 5.2）。
 *   3. 取距 nowMs 最近的签名作"此刻"，渲染当前时空概览（时段 / 场景 / 在场 / 前台应用）。
 *   4. 列出最近 N 条签名的简洁摘要（按 createdAt 距今升序，拷贝后排序，绝不改入参）。
 *   5. 超长按 maxChars 截断并追加省略标记（防 token 膨胀）。
 *   6. 全程 try/catch 兜底：任何异常返回空串而不崩溃。
 *
 * 仅依据入参渲染：不读系统时钟（一律用入参 nowMs）、不修改 signatures 列表
 * （需要排序时先 slice 拷贝）（Requirement 5.4）。
 *
 * @param signatures 活跃时空签名列表（通常已由 `getActiveSignatures` 过滤排序）
 * @param nowMs 当前参考时刻的毫秒时间戳
 * @param maxChars 输出字符上限，默认 1200；为 0（或负 / 非有限）时返回空串
 * @returns 中文纯文本块；空列表返回占位串；异常或上限为 0 返回空串
 */
export function renderChronotopicBlock(
  signatures: readonly ChronotopicSignature[],
  nowMs: number,
  maxChars: number = DEFAULT_MAX_CHARS,
): string {
  try {
    // 防越界：上限为 0（或负 / 非有限）→ 空输出。
    if (!Number.isFinite(maxChars) || maxChars <= 0) return "";

    // Requirement 5.2：空签名列表 → 固定占位串（占位串本身亦受上限约束）。
    if (!signatures || signatures.length === 0) {
      return EMPTY_PLACEHOLDER.length <= maxChars
        ? EMPTY_PLACEHOLDER
        : EMPTY_PLACEHOLDER.slice(0, maxChars);
    }

    const lines: string[] = [BLOCK_HEADER];

    // 当前时空概览：取距 nowMs 最近的签名作"此刻"。
    const current = pickCurrentSignature(signatures, nowMs);
    const currentParts: string[] = [
      `时段：${dayOfWeekLabel(current.temporal.dayOfWeek)}${timeOfDayLabel(current.temporal.timeOfDay)}`,
      `场景：${sceneLabel(current.scene)}`,
      `在场：${presenceLabel(current.presence)}`,
    ];
    const currentApp = current.frontAppName?.trim();
    if (currentApp) currentParts.push(`前台应用：${currentApp}`);
    lines.push(`此刻：${currentParts.join("　")}`);

    // 最近 N 条签名的简洁摘要（拷贝后按 createdAt 距今升序排序，绝不改入参）。
    const recent = signatures
      .slice()
      .sort((a, b) => {
        const ageA = (() => {
          const ms = Date.parse(a.createdAt);
          return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ageMs(ms, nowMs);
        })();
        const ageB = (() => {
          const ms = Date.parse(b.createdAt);
          return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ageMs(ms, nowMs);
        })();
        return ageA - ageB;
      })
      .slice(0, DEFAULT_RECENT_N);

    if (recent.length > 0) {
      lines.push("近期时空：");
      for (const sig of recent) {
        lines.push(`· ${renderSignatureSummary(sig)}`);
      }
    }

    const block = lines.join("\n");

    // 超长截断，追加省略标记（标记本身也纳入上限）。
    if (block.length <= maxChars) return block;
    if (maxChars <= TRUNCATION_MARK.length) return block.slice(0, maxChars);
    return block.slice(0, maxChars - TRUNCATION_MARK.length) + TRUNCATION_MARK;
  } catch {
    // 兜底：渲染失败时返回空串而不崩溃。
    return "";
  }
}
