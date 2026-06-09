/**
 * proactive-awareness-demo —— 上下文感知器（日历/剪贴板/活跃窗口）。
 *
 * 扩展扫描层的感知面，新增三类信号源：
 *  - CalendarSensor：通过 AppleScript 只读查询 Calendar.app 近期事件。
 *  - ClipboardSensor：通过 pbpaste 获取剪贴板文本摘要（前 200 字符）。
 *  - FrontWindowSensor：通过 AppleScript 获取最前面应用和窗口标题。
 *
 * 安全约束：
 *  - 纯只读采集，绝不修改系统状态。
 *  - 剪贴板：跳过疑似密码/密钥内容，仅取前 200 字符。
 *  - 日历：仅取标题和时间，不含备注/描述/参与者邮箱。
 *  - 所有外部命令设 5s 超时，失败时静默降级（返回空/null）。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  CalendarEvent,
  ClipboardSnapshot,
  FrontWindow,
  ScanSummaryItem,
} from "./types.js";

const execFileAsync = promisify(execFile);
const TIMEOUT_MS = 5000;
const MAX_BUFFER = 1024 * 1024;

/** 剪贴板预览最大字符数。 */
const CLIPBOARD_PREVIEW_LENGTH = 200;

/**
 * 疑似敏感内容的正则（密码、密钥、token 等）。
 * 匹配到则跳过剪贴板采集，避免泄露。
 */
const SENSITIVE_PATTERNS = [
  /password[:\s=]/i,
  /secret[:\s=]/i,
  /token[:\s=]/i,
  /api[_-]?key[:\s=]/i,
  /private[_-]?key/i,
  /-----BEGIN\s+(RSA|EC|OPENSSH|PGP)\s+PRIVATE\s+KEY/i,
  /^sk-[a-zA-Z0-9]{20,}/m,  // OpenAI/Anthropic key pattern
  /^ghp_[a-zA-Z0-9]{36,}/m,  // GitHub PAT
];

// ===========================================================================
// CalendarSensor — macOS Calendar.app 只读查询
// ===========================================================================

/**
 * 获取今天和明天的日历事件（标题+时间，不含敏感信息）。
 * 失败时返回空数组。
 */
export async function collectCalendarEvents(): Promise<CalendarEvent[]> {
  if (process.platform !== "darwin") return [];

  // AppleScript: 获取今天和明天的事件
  const script = `
    use framework "Foundation"
    use framework "EventKit"
    use scripting additions

    set today to current date
    set time of today to 0
    set tomorrow to today + (2 * days)

    set output to ""
    tell application "Calendar"
      repeat with cal in calendars
        set calName to name of cal
        set evts to (every event of cal whose start date >= today and start date < tomorrow)
        repeat with evt in evts
          set evtTitle to summary of evt
          set evtStart to start date of evt
          set evtEnd to end date of evt
          set output to output & calName & "\\t" & evtTitle & "\\t" & (evtStart as «class isot» as string) & "\\t" & (evtEnd as «class isot» as string) & "\\n"
        end repeat
      end repeat
    end tell
    return output
  `;

  try {
    const { stdout } = await execFileAsync("osascript", ["-e", script], {
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    });

    const events: CalendarEvent[] = [];
    for (const line of stdout.trim().split("\n")) {
      if (!line.trim()) continue;
      const [calendarName, title, startDate, endDate] = line.split("\t");
      if (title) {
        events.push({
          title: title.trim(),
          startDate: startDate?.trim() || new Date().toISOString(),
          endDate: endDate?.trim() || new Date().toISOString(),
          calendarName: calendarName?.trim(),
        });
      }
    }
    return events;
  } catch {
    // Calendar.app 不可用 / 无权限：静默降级
    return [];
  }
}

// ===========================================================================
// ClipboardSensor — pbpaste 剪贴板只读采集
// ===========================================================================

/**
 * 获取剪贴板文本摘要。跳过空内容和疑似敏感内容。
 * 失败时返回 null。
 */
export async function collectClipboard(): Promise<ClipboardSnapshot | null> {
  if (process.platform !== "darwin") return null;

  try {
    const { stdout } = await execFileAsync("pbpaste", [], {
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    });

    const text = stdout;
    if (!text || text.trim().length === 0) return null;

    // 安全过滤：疑似密码/密钥则跳过
    for (const pattern of SENSITIVE_PATTERNS) {
      if (pattern.test(text)) return null;
    }

    return {
      preview: text.slice(0, CLIPBOARD_PREVIEW_LENGTH),
      fullLength: text.length,
      capturedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

// ===========================================================================
// FrontWindowSensor — 最前面窗口信息
// ===========================================================================

/**
 * 获取最前面应用的窗口标题。
 * 失败时返回 null。
 */
export async function collectFrontWindow(): Promise<FrontWindow | null> {
  if (process.platform !== "darwin") return null;

  const script = `
    tell application "System Events"
      set frontApp to first application process whose frontmost is true
      set appName to name of frontApp
      try
        set winTitle to name of front window of frontApp
      on error
        set winTitle to ""
      end try
      return appName & "\\t" & winTitle
    end tell
  `;

  try {
    const { stdout } = await execFileAsync("osascript", ["-e", script], {
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    });

    const [appName, windowTitle] = stdout.trim().split("\t");
    if (!appName) return null;

    return {
      appName: appName.trim(),
      windowTitle: (windowTitle || "").trim(),
      capturedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

// ===========================================================================
// 打分 & 转成 ScanSummaryItem
// ===========================================================================

/** 日历事件基础分：即将到来的事件是重要的上下文信号。 */
const CALENDAR_BASE_SCORE = 1.5;
/** 剪贴板基础分：当下工作的直接上下文，中等信号。 */
const CLIPBOARD_BASE_SCORE = 1.2;
/** 活跃窗口基础分：当下焦点的强信号。 */
const WINDOW_BASE_SCORE = 1.8;

/**
 * 收集所有扩展感知面信号，返回打好分的 ScanSummaryItem 数组。
 * 任何单个感知器失败不影响其他的采集。
 */
export async function collectContextSignals(): Promise<ScanSummaryItem[]> {
  const items: ScanSummaryItem[] = [];

  // 并发采集三个感知面
  const [calendarEvents, clipboard, frontWindow] = await Promise.all([
    collectCalendarEvents(),
    collectClipboard(),
    collectFrontWindow(),
  ]);

  // 日历事件
  for (const event of calendarEvents) {
    // 越近的事件分越高
    const now = Date.now();
    const start = new Date(event.startDate).getTime();
    const hoursUntil = (start - now) / (1000 * 60 * 60);
    // 1小时内的事件最高分，24小时后的事件降到基础分
    const urgencyBoost = hoursUntil <= 1 ? 1.0 : hoursUntil <= 4 ? 0.5 : 0;
    items.push({
      kind: "calendar",
      score: CALENDAR_BASE_SCORE + urgencyBoost,
      calendar: event,
    });
  }

  // 剪贴板
  if (clipboard) {
    items.push({
      kind: "clipboard",
      score: CLIPBOARD_BASE_SCORE,
      clipboard,
    });
  }

  // 活跃窗口
  if (frontWindow) {
    items.push({
      kind: "window",
      score: WINDOW_BASE_SCORE,
      window: frontWindow,
    });
  }

  return items;
}
