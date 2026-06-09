/**
 * proactive-awareness-demo —— 扫描层类型定义（任务 4.1）。
 *
 * 本文件是扫描层数据类型的**权威来源**（design.md「扫描层」/「Scan_Summary 类型」）：
 *  - `FileMeta` / `GitActivity` / `AppActivity` / `ScanSummaryItem` / `Scan_Summary`
 *    —— 扫描产出的结构化摘要（已是 Top N、已应用排除红线，仅 Summary 外传）。
 *  - `ScanOptions` —— 单次扫描的入参（扫描起点/时间窗/Top N）。
 *  - `ScanProgressEvent` —— 扫描具身化流式进度载荷（SSE `scan:progress` 事件，
 *    可选增强、接口先预留）。
 *
 * 设计约束：
 *  - **仅元信息原则**：所有扫描产物（含进度线索）只承载元信息（文件名/路径/mtime/
 *    大小/扩展名、git 只读活动、App 名），**绝不含文件正文**（R3.1/R3.5/R4.4/R18.4）。
 *  - 字段结构与 `orchestrator/session.ts` 中的同名占位定义保持一致，便于任务 14.6 对齐。
 *
 * _Requirements: 2.1, 2.4, 3.4, 16.2_
 */

// ===========================================================================
// Scan_Summary 类型族（design.md「Scan_Summary 类型」R3.4）
// ===========================================================================

/**
 * 文件元信息。**仅元信息，绝不含正文**（R3.1/R4.4）。
 * 由阶段1 规则粗筛采集（`mtime ≥ now - recentDays`）。
 */
export interface FileMeta {
  /** 文件名（含扩展名）。 */
  name: string;
  /** 绝对路径。 */
  path: string;
  /** 最近修改时间，ISO8601。 */
  mtime: string;
  /** 文件大小（字节）。 */
  sizeBytes: number;
  /** 扩展名（含点或不含点由采集侧约定，类型层不强制）。 */
  ext: string;
}

/**
 * 近期 git 只读活动。
 * 由对发现的 git 仓库根执行 `git log --since` 等**只读**命令提取。
 */
export interface GitActivity {
  /** git 仓库根绝对路径。 */
  repoPath: string;
  /** 近期提交（仅哈希/提交信息/日期，不含 diff 正文）。 */
  recentCommits: { hash: string; message: string; date: string }[];
  /** 近 recentDays 天涉及的文件（**仅路径**，不含内容）。 */
  changedFiles: string[];
  /** 当前分支名。 */
  currentBranch: string;
}

/**
 * 当前在用 App（由 macOS 运行中应用列表只读采集）。
 */
export interface AppActivity {
  /** 应用名称。 */
  appName: string;
  /** Bundle 标识（可选）。 */
  bundleId?: string;
}

// ===========================================================================
// 扩展感知面类型（日历/剪贴板/活跃窗口）
// ===========================================================================

/**
 * 近期日历事件（由 Calendar.app 只读查询）。
 * 仅记录事件标题、起止时间，不含正文/备注/参与者邮箱（隐私最小化）。
 */
export interface CalendarEvent {
  /** 事件标题。 */
  title: string;
  /** 开始时间 ISO8601。 */
  startDate: string;
  /** 结束时间 ISO8601。 */
  endDate: string;
  /** 所属日历名（如"工作""个人"）。 */
  calendarName?: string;
}

/**
 * 剪贴板摘要。仅取前 N 字符作为信号，不持久化完整内容。
 * 若内容疑似密码/密钥，应跳过不采集。
 */
export interface ClipboardSnapshot {
  /** 截取的前 N 字符（默认 200）。 */
  preview: string;
  /** 原始长度（字符数）。 */
  fullLength: number;
  /** 采集时间 ISO8601。 */
  capturedAt: string;
}

/**
 * 最前面窗口信息。
 */
export interface FrontWindow {
  /** 所属应用名。 */
  appName: string;
  /** 窗口标题（如文件名、网页标题）。 */
  windowTitle: string;
  /** 采集时间 ISO8601。 */
  capturedAt: string;
}

/**
 * 精选后的单条扫描摘要项。
 * `kind` 决定 `file`/`git`/`app`/`calendar`/`clipboard`/`window` 中哪一个被填充。
 */
export interface ScanSummaryItem {
  /** 条目种类。 */
  kind: "file" | "git" | "app" | "calendar" | "clipboard" | "window";
  /** 精选打分（新近度 + git 活跃度 + 同目录聚类度）。 */
  score: number;
  /** kind === "file" 时填充。 */
  file?: FileMeta;
  /** kind === "git" 时填充。 */
  git?: GitActivity;
  /** kind === "app" 时填充。 */
  app?: AppActivity;
  /** kind === "calendar" 时填充。 */
  calendar?: CalendarEvent;
  /** kind === "clipboard" 时填充。 */
  clipboard?: ClipboardSnapshot;
  /** kind === "window" 时填充。 */
  window?: FrontWindow;
}

/**
 * 扫描摘要。**已是 Top N、已应用排除红线**，是唯一外传给 Analyzer 的扫描产物
 * （原始粗筛数据不外传，R3.5）。
 */
export interface Scan_Summary {
  /** 扫描完成时间，ISO8601。 */
  scannedAt: string;
  /** 扫描所在平台（如 "darwin"）。 */
  platform: string;
  /** 时间窗天数（默认 7）。 */
  recentDays: number;
  /** 已精选并过滤的条目集合。 */
  items: ScanSummaryItem[];
}

// ===========================================================================
// ScanOptions —— 单次扫描入参（design.md「Device_Scanner 接口契约」）
// ===========================================================================

/**
 * 单次扫描的入参。
 */
export interface ScanOptions {
  /** 时间窗天数，默认 7（R3.1/R3.2）。 */
  recentDays: number;
  /** Top N 精选数量，默认 15（R3.4）。 */
  topN: number;
  /** 扫描起点（用户主目录）。 */
  homeDir: string;
}

// ===========================================================================
// ScanProgressEvent —— 扫描具身化流式进度载荷（可选增强，接口先预留）
// ===========================================================================

/**
 * SSE `scan:progress` 事件载荷（扫描具身化，可选增强 / MVP 之后可追加）。
 *
 * 用途：让"系统正在查看你的电脑"这一过程可被用户**看见**——在**阶段1 粗筛**过程中，
 * 每发现一批新的文件 / git 仓库 / 在用 App，即推送一条本事件，由 Orchestrator 经 SSE
 * 转发给前端，渲染成滚动的"系统正在查看…"线索流（与执行阶段的 `execution-progress`
 * 动作流呼应，但分属扫描阶段、互不干扰）。
 *
 * 安全约束：`found` **仅承载已通过排除红线的元信息级线索**（文件名/路径片段、git
 * 仓库名、App 名），**绝不含文件正文**，与 `Scan_Summary` 的纯元信息原则一致
 * （R3.5/R4.4）。
 */
export interface ScanProgressEvent {
  /** 事件类型判别标签。 */
  type: "scan:progress";
  /** 本批新发现的线索摘要（**仅元信息级**：文件名/路径片段、仓库名、App 名）。 */
  found: string[];
}
