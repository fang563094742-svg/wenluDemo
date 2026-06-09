/**
 * proactive-awareness-demo —— 扫描层「排除红线」纯函数策略（任务 4.2）。
 *
 * 本文件实现 design.md「排除红线实现（R4, R18.4）」中定义的 `ExclusionPolicy`：
 * 在阶段1 粗筛的**采集阶段即生效**（采集前判定，越早排除越安全），把以下三类路径
 * 在元信息层面直接排除，使其**绝不进入 `Scan_Summary`**：
 *
 *   1. 系统级路径黑名单（R4.1）—— `/System`、`/usr`、`/bin`、`/sbin`、`/private`、
 *      `/Applications`、根 `/Library` 以及用户 `~/Library`。
 *   2. 加密文件 / 已知加密容器（R4.2）—— 按扩展名（`.gpg`/`.asc`/`.aes`/`.enc` 等）
 *      与已知加密容器目录（`.gnupg`/`.ssh`、加密磁盘映像等）排除。
 *   3. 聊天记录目录（R4.3）—— iMessage（`~/Library/Messages`）、微信容器
 *      （`com.tencent.xinWeChat`）及其他已知 IM 容器（QQ / Telegram / WhatsApp）。
 *
 * 设计契约（与 design.md 一致）：
 *  - **纯函数**：`isExcluded(path, meta)` 不做任何 I/O、不读文件正文、对相同输入恒返回
 *    相同结果，便于属性测试（PBT 任务 4.3 覆盖）。
 *  - **仅元信息**：判定只依赖路径字符串与 `FileMeta` 元信息（文件名/扩展名等），
 *    **绝不读取被排除内容的正文**，满足 R4.4 / R18.4。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 【加密排除的尽力而为（best-effort）局限声明 —— 呼应"扫描前隐私告知"，对抗性审查后补充】
 *
 *  基于规则（路径前缀 / 扩展名 / 已知容器）的加密文件排除是**尽力而为（best-effort）**的，
 *  无法保证识别所有加密文件 —— 我们刻意**不做内容级加密检测 / 不嗅探文件正文**
 *  （保持最小化，避免读正文带来更大的隐私风险），因此新型、改名或无显著扩展名特征的
 *  加密容器可能漏判。更进一步，扫描在判定排除前必然会**枚举到文件名与路径本身**
 *  （即便该文件最终被排除），这本身已是隐私信息的一种暴露。
 *
 *  因此 System **不向用户承诺"绝对不会触及任何加密 / 敏感文件"**，而是：
 *    (a) 在本 `ExclusionPolicy` 中尽最大努力按规则排除；
 *    (b) 由 Conversation_UI 的"扫描前隐私告知"把上述局限透明告知用户，
 *        确保用户在**知情前提下**决定是否触发扫描（R4）。
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * _Requirements: 4.1, 4.2, 4.3, 4.4, 18.4_
 */

import type { FileMeta } from "./types.js";

// ===========================================================================
// 排除红线策略接口（design.md「排除红线实现」）
// ===========================================================================

/**
 * 排除红线策略契约。
 */
export interface ExclusionPolicy {
  /**
   * 返回 `true` 表示该路径必须被排除，**不纳入 `Scan_Summary`**。
   *
   * 纯函数：仅依据 `path` 与 `meta` 元信息判定，不做 I/O、不读文件正文
   * （R4.4 / R18.4）。加密排除为 best-effort（见文件头声明）。
   *
   * @param path 文件 / 目录的绝对路径。
   * @param meta 文件元信息（用于扩展名等判定，绝不含正文）。
   */
  isExcluded(path: string, meta: FileMeta): boolean;
}

// ===========================================================================
// 规则数据（导出以便测试与扩展；均为小写、用于大小写不敏感匹配）
// ===========================================================================

/**
 * 系统级路径的**顶层目录段**黑名单（R4.1）。
 * 命中条件：作为根下第一段（`/<dir>/…`），或作为用户主目录下第一段
 * （`/Users/<name>/<dir>/…`，主要针对 `Library`）。
 */
export const SYSTEM_TOP_DIRS: readonly string[] = [
  "system",
  "usr",
  "bin",
  "sbin",
  "private",
  "applications",
  "library", // 根 /Library 与用户 ~/Library 均排除
] as const;

/**
 * 加密文件扩展名黑名单（R4.2）。统一以**不含点的小写**形式比较。
 * best-effort：仅覆盖常见加密 / 密钥容器扩展名，无法穷尽（见文件头声明）。
 */
export const ENCRYPTED_EXTENSIONS: readonly string[] = [
  "gpg",
  "pgp",
  "asc",
  "aes",
  "enc",
  "kdbx", // KeePass 密码库
  "p12", // PKCS#12 证书 / 私钥容器
  "pfx",
  "crypt",
  "cpt", // Crypt / Encrypto
  "axx", // AxCrypt
  "sparsebundle", // 加密磁盘映像（FileVault 稀疏束）
  "sparseimage", // 加密稀疏磁盘映像
] as const;

/**
 * 已知加密 / 密钥**容器目录段**黑名单（R4.2）。
 * 以路径段（segment）精确匹配，命中即排除整个子树。
 */
export const ENCRYPTED_CONTAINER_SEGMENTS: readonly string[] = [
  ".gnupg", // GnuPG 密钥环
  ".ssh", // SSH 私钥
  ".gpg",
] as const;

/**
 * 聊天记录 / IM 容器路径标记（R4.3）。以**大小写不敏感子串**匹配。
 * 涵盖 iMessage 与常见 IM 桌面客户端的沙盒容器目录。
 */
export const CHAT_PATH_MARKERS: readonly string[] = [
  "/library/messages", // iMessage 聊天数据库（chat.db 等）
  "com.tencent.xinwechat", // 微信（新版容器）
  "com.tencent.wechat", // 微信（旧版 / 兼容）
  "com.tencent.qq", // QQ
  "ru.keepcoder.telegram", // Telegram macOS
  "org.telegram.desktop", // Telegram Desktop
  "net.whatsapp.whatsapp", // WhatsApp
] as const;

// ===========================================================================
// 工具运行时噪音规则（Improvement 1「察觉相关性」第 1 层）
// ---------------------------------------------------------------------------
// 活体检阅暴露：扫描产出的察觉几乎全是「工具/系统自动产生的运行时产物」——
// 包管理器调试日志（.npm/_logs）、AI agent 会话记录（rollout/trajectory/.jsonl 备份）、
// 缓存、锁文件、依赖目录、数据库 WAL、纯 hash blob 等——而非用户作为人真正在做/在想的事。
// 这些是「机器活动」，不代表用户意图，必须在元信息层面尽早排除，绝不进入 Scan_Summary。
//
// 与 R4 系统/加密/聊天红线正交：本组规则只针对「工具运行时噪音」，判定仍是纯函数、
// 仅依据 path / meta（文件名、扩展名、路径段），绝不读取文件正文。
// ===========================================================================

/**
 * 用户级工具 / 缓存点目录段（小写、精确段匹配，命中即排除整棵子树）。
 * 这些目录里的内容几乎全是工具自动生成的运行时产物，不反映用户主动创作。
 */
export const TOOL_NOISE_DIR_SEGMENTS: readonly string[] = [
  ".npm",
  ".cache",
  ".local",
  ".config",
  ".codex",
  ".cursor",
  ".vscode",
  ".vscode-server",
  ".trash",
  ".cargo",
  ".rustup",
  ".gem",
  ".bundle",
  ".gradle",
  ".m2",
  ".pyenv",
  ".nvm",
  ".deno",
  ".bun",
  ".docker",
  ".kube",
  ".terraform",
  ".venv",
  "venv",
  "__pycache__",
  "node_modules",
  ".pnpm-store",
  ".yarn",
  ".next",
  ".nuxt",
  ".turbo",
  "dist",
  "build",
  ".git",
] as const;

/**
 * 噪音扩展名黑名单（不含点、小写匹配）。覆盖日志 / 锁 / 临时 / 缓存 / 字节码 /
 * 数据库辅助文件（WAL/SHM）等机器产物。
 *
 * 注意 `normalizedExt` 取最后一个点之后的片段：`db.sqlite-wal` 的 ext 为 `sqlite-wal`，
 * 故此处显式纳入 `sqlite-wal`/`sqlite-shm`/`db-wal`/`db-shm`。
 */
export const NOISE_EXTENSIONS: readonly string[] = [
  "log",
  "lock",
  "pid",
  "tmp",
  "temp",
  "swp",
  "swo",
  "bak",
  "old",
  "cache",
  "shm",
  "wal",
  "sock",
  "pyc",
  "pyo",
  "class",
  "o",
  "lockb",
  "sqlite-shm",
  "sqlite-wal",
  "db-shm",
  "db-wal",
] as const;

/**
 * 噪音文件名模式（针对 basename，大小写不敏感）。覆盖：
 *  - AI agent 会话 / 备份：`rollout-*.jsonl`、`*.jsonl.bak-*`、`*.trajectory*`；
 *  - 通用备份：`*.bak`、`*.bak-1490-178…`、`*.bak.20260605`；
 *  - 纯 hash / 无扩展名 blob：长十六进制串（git 对象、内容寻址缓存等）；
 *  - 日志轮转：`*-debug-0.log`、`*.log.1`；
 *  - 锁 / 状态：`.DS_Store`、以 `.` 开头且以 `.lock`/`.pid` 结尾的隐藏锁文件。
 */
const NOISE_BASENAME_PATTERNS: readonly RegExp[] = [
  /^rollout-.*\.jsonl/i, // AI agent 会话记录
  /\.jsonl\.bak-/i, // jsonl 会话备份
  /\.trajectory/i, // agent 轨迹文件
  /\.bak[-.]?\d*/i, // 通用备份（.bak / .bak-123 / .bak.20260605）
  /-debug-\d+\.log$/i, // 调试日志轮转
  /\.log\.\d+$/i, // 日志轮转（.log.1）
  /^\..*\.lock$/i, // 隐藏锁文件
  /^\..*\.pid$/i, // 隐藏 pid 文件
] as const;

/** macOS / 工具产生的固定噪音文件名（小写精确匹配 basename）。 */
const NOISE_EXACT_BASENAMES: readonly string[] = [".ds_store"] as const;

/** 纯十六进制 blob（≥16 位，无扩展名），如 git 对象 / 内容寻址缓存。 */
const HASH_BLOB_RE = /^[0-9a-f]{16,}$/i;

// ===========================================================================
// 内部纯工具函数
// ===========================================================================

/**
 * 归一化路径：统一为正斜杠分隔、去掉首尾空白。**不触碰文件系统**。
 */
function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").trim();
}

/**
 * 将路径切分为非空路径段（小写），用于段级匹配。
 */
function pathSegments(normalized: string): string[] {
  return normalized
    .toLowerCase()
    .split("/")
    .filter((seg) => seg.length > 0);
}

/**
 * 提取**不含点的小写**扩展名：优先使用 `meta.ext`，缺省时从文件名兜底推导。
 */
function normalizedExt(path: string, meta: FileMeta): string {
  const fromMeta = (meta.ext ?? "").trim().toLowerCase().replace(/^\.+/, "");
  if (fromMeta.length > 0) {
    return fromMeta;
  }
  // 兜底：从路径最后一段的最后一个点之后推导。
  const base = normalizePath(path).split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/**
 * 规则 1：系统级路径黑名单（R4.1）。
 * 命中：根下第一段为系统目录（`/<dir>/…`），或 `/Users/<name>/<dir>/…` 下第一段
 * 为系统目录（覆盖 `~/Library`）。
 */
function isSystemPath(segments: string[]): boolean {
  if (segments.length === 0) {
    return false;
  }
  // /System、/usr、/Library 等根级系统目录。
  if (SYSTEM_TOP_DIRS.includes(segments[0]!)) {
    return true;
  }
  // ~/Library 等：/Users/<name>/<systemTopDir>/…
  if (
    segments[0] === "users" &&
    segments.length >= 3 &&
    SYSTEM_TOP_DIRS.includes(segments[2]!)
  ) {
    return true;
  }
  return false;
}

/**
 * 规则 2：加密文件 / 加密容器（R4.2）。best-effort，详见文件头声明。
 */
function isEncrypted(path: string, segments: string[], meta: FileMeta): boolean {
  if (ENCRYPTED_EXTENSIONS.includes(normalizedExt(path, meta))) {
    return true;
  }
  return segments.some((seg) => ENCRYPTED_CONTAINER_SEGMENTS.includes(seg));
}

/**
 * 规则 3：聊天记录 / IM 容器目录（R4.3）。
 */
function isChatRecord(normalizedLower: string): boolean {
  return CHAT_PATH_MARKERS.some((marker) => normalizedLower.includes(marker));
}

/**
 * 规则 4：工具运行时噪音（Improvement 1 第 1 层）。命中任一即排除。
 *  A. 路径含工具 / 缓存点目录段（命中即整棵子树排除）；
 *  B. 噪音扩展名（日志 / 锁 / 临时 / 缓存 / 字节码 / DB 辅助文件等）；
 *  C. 噪音文件名模式（rollout 会话、通用备份、hash blob、日志轮转、隐藏锁等）。
 * 纯函数：仅依据路径段 / 扩展名 / basename，绝不读取正文。
 */
function isToolNoise(path: string, segments: string[], meta: FileMeta): boolean {
  // A. 工具 / 缓存点目录段。
  if (segments.some((seg) => TOOL_NOISE_DIR_SEGMENTS.includes(seg))) {
    return true;
  }
  // B. 噪音扩展名。
  if (NOISE_EXTENSIONS.includes(normalizedExt(path, meta))) {
    return true;
  }
  // C. 噪音文件名模式。
  const base = (segments.length > 0 ? segments[segments.length - 1]! : "").toLowerCase();
  if (base.length === 0) {
    return false;
  }
  if (NOISE_EXACT_BASENAMES.includes(base)) {
    return true;
  }
  if (HASH_BLOB_RE.test(base)) {
    return true;
  }
  return NOISE_BASENAME_PATTERNS.some((re) => re.test(base));
}

// ===========================================================================
// 公开 API
// ===========================================================================

/**
 * 排除红线判定（纯函数）。命中任一红线即返回 `true`（排除）。
 *
 * 判定顺序无副作用、互不依赖：系统级路径（R4.1）→ 加密文件 / 容器（R4.2）→
 * 聊天记录目录（R4.3）→ 工具运行时噪音（Improvement 1 第 1 层）。仅依赖路径与元信息，
 * **绝不读取正文**（R4.4 / R18.4）。
 *
 * @param path 文件 / 目录绝对路径。
 * @param meta 文件元信息（仅用于扩展名等判定）。
 * @returns `true` 表示必须排除；`false` 表示可纳入后续粗筛 / 精选。
 */
export function isExcluded(path: string, meta: FileMeta): boolean {
  const normalized = normalizePath(path);
  if (normalized.length === 0) {
    return false;
  }
  const segments = pathSegments(normalized);
  const normalizedLower = normalized.toLowerCase();

  return (
    isSystemPath(segments) ||
    isEncrypted(path, segments, meta) ||
    isChatRecord(normalizedLower) ||
    isToolNoise(path, segments, meta)
  );
}

/**
 * 默认排除红线策略实例（`ExclusionPolicy` 契约的具体实现），供 Mac_Scanner
 * 与注册表注入使用。委托给上方 `isExcluded` 纯函数。
 */
export const defaultExclusionPolicy: ExclusionPolicy = {
  isExcluded,
};
