/**
 * 时空校准层 · 时空签名构建模块（Component 2：chronotopic-signature.ts）
 * ------------------------------------------------------------------
 * 把「针对哪个目标（who/what）、在什么时间（when）、处于什么场景（where）、
 * 用户当前在不在场（presence）」这四要素，确定性地凝结成一枚可幂等复算的
 * 时空签名（ChronotopicSignature）。本模块构建在 chronotopic-time.ts 之上，
 * 消费扫描层（src/scanner/types.ts）的 FrontWindow / CalendarEvent /
 * ClipboardSnapshot 作为瞬时传感输入。
 *
 * 设计要点（参见 design.md Component 2 与 requirements.md R2/R12/R15.4）：
 *  - 确定性纯函数：`nowMs` / `userLastActiveAtMs` / `tzOffsetMinutes` 一律显式入参，
 *    不读真实时钟、不读随机源；相同 (targetRef, 时间桶, scene) 必得相同 signatureId。
 *  - 不修改入参、无副作用。剪贴板仅作 scene 的瞬时判别输入，绝不写入签名。
 *  - 传感器全空时仍产出合法签名（scene="idle"、frontAppName=null）。
 *
 * 绝对边界（贯穿全时空层，参见 requirements.md Requirement 14）：
 *  - 不 import 任何 3.1 / 3.2 路径的代码、不调其 API、不碰其 sqlite。
 *  - 不 import "server-only"、不 import "node:sqlite"、不用 @/lib 路径别名。
 *  - 纯 TypeScript ESM，相对导入一律带 `.js` 扩展（Node ≥ 22）。
 */

import { createHash } from "node:crypto";
import { deriveTemporalDimension, type TemporalDimension } from "./chronotopic-time.js";
import type { FrontWindow, CalendarEvent, ClipboardSnapshot } from "../scanner/types.js";

/**
 * 时空签名所指向的目标引用（who/what）。
 *
 * `kind` 标识目标在认知系统中的类别，`id` 是该类别内的稳定标识。
 */
export interface ChronotopicTargetRef {
  /** 目标类别。 */
  kind: "riverbed-node" | "episode" | "concept" | "belief" | "event";
  /** 目标在其类别内的稳定标识（不可为空白）。 */
  id: string;
}

/**
 * 场景档（where）。由前台应用 / 日历事件确定性映射。
 *  - `coding`：编码 / 开发
 *  - `meeting`：会议（含日历正在进行的事件）
 *  - `browsing`：浏览网页
 *  - `writing`：写作 / 文档
 *  - `communication`：即时通讯 / 邮件
 *  - `idle`：无可用传感信号（空闲）
 *  - `unknown`：有前台应用但无法归入上述任一场景
 */
export type ChronotopicScene =
  | "coding"
  | "meeting"
  | "browsing"
  | "writing"
  | "communication"
  | "idle"
  | "unknown";

/**
 * 在场档（presence）。由用户距上次活跃的分钟数确定性划分。
 *  - `present`：0-2 分钟（含 0），视为在场
 *  - `recently_active`：3-30 分钟，刚离开
 *  - `away`：> 30 分钟，已离开
 */
export type ChronotopicPresence = "present" | "recently_active" | "away";

/** 时空签名（when × where × who × presence）。 */
export interface ChronotopicSignature {
  /** 签名指纹：由 (kind + id + timeBucket + scene) 经 sha256 取前若干位得到，幂等。 */
  signatureId: string;
  /** 目标引用（who/what）。 */
  targetRef: ChronotopicTargetRef;
  /** 时间维度（when）。 */
  temporal: TemporalDimension;
  /** 场景档（where）。 */
  scene: ChronotopicScene;
  /** 前台应用名；无前台窗口时为 null。 */
  frontAppName: string | null;
  /** 在场档。 */
  presence: ChronotopicPresence;
  /** 用户距上次活跃的分钟数（非负整数）。 */
  userAwayMinutes: number;
  /** 签名构建时刻，ISO8601（由 interaction.nowMs 转换得到）。 */
  createdAt: string;
}

/**
 * 瞬时传感输入（来自扫描层，只消费不重定义）。
 *
 * 这些字段只参与 scene / frontAppName 的瞬时判别，签名本身不持久化它们的原文。
 */
export interface ChronotopicSensorInput {
  /** 最前面窗口；无则 null。 */
  frontWindow: FrontWindow | null;
  /** 近期日历事件集合（可空数组）。 */
  calendarEvents: CalendarEvent[];
  /** 剪贴板摘要；仅作瞬时输入，不写入签名；无则 null。 */
  clipboard: ClipboardSnapshot | null;
}

/** 交互时刻输入（用户在场推导所需的时间锚点）。 */
export interface ChronotopicInteractionInput {
  /** 用户上次活跃的毫秒时间戳。 */
  userLastActiveAtMs: number;
  /** 当前参考时刻的毫秒时间戳。 */
  nowMs: number;
}

/** 每分钟的毫秒数。 */
const MS_PER_MINUTE = 60_000;
/** 在场判定上界（分钟，含）：≤ 此值视为在场。 */
const PRESENT_MAX_MINUTES = 2;
/** 刚离开判定上界（分钟，含）：≤ 此值视为刚离开。 */
const RECENTLY_ACTIVE_MAX_MINUTES = 30;
/** signatureId 取 sha256 十六进制摘要的前若干位。 */
const SIGNATURE_ID_LENGTH = 16;

/**
 * 场景关键词映射表（确定性）。按声明顺序优先匹配：先 coding，再 meeting…
 * 每个关键词不区分大小写匹配前台应用名（appName）。
 */
const SCENE_KEYWORDS: { scene: ChronotopicScene; keywords: string[] }[] = [
  { scene: "coding", keywords: ["code", "xcode", "终端", "terminal", "iterm", "vim", "intellij", "pycharm", "webstorm"] },
  { scene: "meeting", keywords: ["zoom", "meet", "腾讯会议", "tencent meeting", "webex", "teams"] },
  { scene: "browsing", keywords: ["safari", "chrome", "浏览器", "firefox", "edge", "arc", "browser"] },
  { scene: "writing", keywords: ["备忘录", "notes", "word", "pages", "写作", "ulysses", "bear", "typora", "notion"] },
  { scene: "communication", keywords: ["微信", "wechat", "mail", "消息", "messages", "slack", "钉钉", "dingtalk", "飞书", "lark", "telegram"] },
];

/**
 * 判断某日历事件在 nowMs 时刻是否正在进行（[startDate, endDate) 半开区间）。
 *
 * 解析失败（NaN）的事件按「不在进行」处理，绝不抛错。
 *
 * @param event 日历事件
 * @param nowMs 当前参考时刻
 * @returns 是否正在进行
 */
function isEventOngoing(event: CalendarEvent, nowMs: number): boolean {
  const start = Date.parse(event.startDate);
  const end = Date.parse(event.endDate);
  if (Number.isNaN(start) || Number.isNaN(end)) return false;
  return start <= nowMs && nowMs < end;
}

/**
 * 由传感信号确定性映射场景档（where）。
 *
 * 规则（确定性，优先级自上而下）：
 *  1. 若有日历事件在 nowMs 正在进行 → "meeting"（会议优先）。
 *  2. 否则由前台应用名按 SCENE_KEYWORDS 顺序关键词匹配（coding/meeting/browsing/
 *     writing/communication）。
 *  3. 无前台窗口 → "idle"（空闲）。
 *  4. 有前台窗口但无法归类 → "unknown"。
 *
 * @param frontWindow 最前面窗口（可为 null）
 * @param calendarEvents 日历事件集合
 * @param nowMs 当前参考时刻（用于判定日历事件是否正在进行）
 * @returns 场景档
 */
function mapSceneFromSensors(
  frontWindow: FrontWindow | null,
  calendarEvents: CalendarEvent[],
  nowMs: number,
): ChronotopicScene {
  // 1. 日历正在进行的事件优先判为会议。
  if (calendarEvents.some((event) => isEventOngoing(event, nowMs))) {
    return "meeting";
  }

  // 2. 由前台应用名关键词映射。
  if (frontWindow !== null) {
    const appNameLower = frontWindow.appName.toLowerCase();
    for (const { scene, keywords } of SCENE_KEYWORDS) {
      if (keywords.some((kw) => appNameLower.includes(kw.toLowerCase()))) {
        return scene;
      }
    }
    // 3'. 有前台窗口但未命中任何关键词。
    return "unknown";
  }

  // 3. 无任何前台窗口 → 空闲。
  return "idle";
}

/**
 * 由用户距上次活跃分钟数确定性划分在场档。
 *
 * @param awayMinutes 非负的距上次活跃分钟数
 * @returns 在场档
 */
function classifyPresence(awayMinutes: number): ChronotopicPresence {
  if (awayMinutes <= PRESENT_MAX_MINUTES) return "present";
  if (awayMinutes <= RECENTLY_ACTIVE_MAX_MINUTES) return "recently_active";
  return "away";
}

/**
 * 由时间维度推导一个稳定的时间桶字符串，用于签名指纹的幂等性。
 *
 * 桶粒度 = `${dayOfWeek}-${timeOfDay}`：一周位置 × 时段档。相同绝对时刻（在同一
 * 时区偏移下）必落入相同桶，从而让「相同 (targetRef, 时间桶, scene)」复算出相同
 * signatureId。
 *
 * @param temporal 时间维度
 * @returns 稳定的时间桶字符串
 */
function deriveTimeBucket(temporal: TemporalDimension): string {
  return `${temporal.dayOfWeek}-${temporal.timeOfDay}`;
}

/**
 * 构建时空签名（确定性纯函数）。
 *
 * 流程：
 *  - 校验 targetRef.id 非空白，否则抛 Error("CHRONOTOPIC_TARGET_REQUIRED")。
 *  - when：由 nowMs + tzOffsetMinutes 推导 TemporalDimension。
 *  - where：由前台窗口 / 日历事件确定性映射 scene；frontAppName = frontWindow?.appName ?? null。
 *  - presence：userAwayMinutes = max(0, floor((nowMs - userLastActiveAtMs)/60000))，再分档。
 *  - signatureId：sha256(kind + id + timeBucket + scene) 取前 16 位十六进制。
 *  - createdAt：nowMs 转 ISO8601。
 *
 * 不修改入参、无副作用。剪贴板仅参与 scene 判别（当前实现不影响结果），不写入签名。
 *
 * @param targetRef 目标引用（who/what）
 * @param sensors 瞬时传感输入
 * @param interaction 交互时刻输入
 * @param tzOffsetMinutes 时区偏移（分钟，东区为正）
 * @returns 时空签名
 * @throws Error("CHRONOTOPIC_TARGET_REQUIRED") 当 targetRef.id 为空白时
 */
export function buildChronotopicSignature(
  targetRef: ChronotopicTargetRef,
  sensors: ChronotopicSensorInput,
  interaction: ChronotopicInteractionInput,
  tzOffsetMinutes: number,
): ChronotopicSignature {
  if (targetRef.id.trim() === "") {
    throw new Error("CHRONOTOPIC_TARGET_REQUIRED");
  }

  const { nowMs, userLastActiveAtMs } = interaction;

  // when：时间维度。
  const temporal = deriveTemporalDimension(nowMs, tzOffsetMinutes);

  // where：场景与前台应用名。
  const scene = mapSceneFromSensors(sensors.frontWindow, sensors.calendarEvents, nowMs);
  const frontAppName = sensors.frontWindow?.appName ?? null;

  // presence：用户在场档。
  const userAwayMinutes = Math.max(0, Math.floor((nowMs - userLastActiveAtMs) / MS_PER_MINUTE));
  const presence = classifyPresence(userAwayMinutes);

  // signatureId：幂等指纹（相同 targetRef + 时间桶 + scene 必得相同）。
  const timeBucket = deriveTimeBucket(temporal);
  const signatureId = createHash("sha256")
    .update(`${targetRef.kind}|${targetRef.id}|${timeBucket}|${scene}`)
    .digest("hex")
    .slice(0, SIGNATURE_ID_LENGTH);

  return {
    signatureId,
    targetRef: { kind: targetRef.kind, id: targetRef.id },
    temporal,
    scene,
    frontAppName,
    presence,
    userAwayMinutes,
    createdAt: new Date(nowMs).toISOString(),
  };
}
