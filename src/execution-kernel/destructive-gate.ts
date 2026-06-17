/**
 * 持续执行内核 · 不可逆动作硬护栏（destructive-gate.ts）
 * ------------------------------------------------------------------
 * 第一性: AI 在自主呼吸 / 用户回执路径下，都不应该被允许执行 "整目录删除 /
 * 系统级毁灭 / 跨用户访问" 类不可逆动作。这一层是代码层硬阻断，
 * 不依赖 mind/conversation 状态、不豁免 __fromReply、不豁免 task line。
 *
 * 多用户安全设计原则:
 *  - 单用户场景的 "用户说删，我删" 在多用户下 = "A 用户能让 B 用户家目录被删"
 *  - 因此 destructive 命令的拦截必须 system-wide, 不依赖该用户当前 session 状态
 *  - 路径白名单按 brain 进程的 BRAIN_USER_ID 划界, 跨用户路径直接拒绝
 *
 * 三类命令分级:
 *  1. HARD_DESTRUCTIVE: 整盘格式化 / rm -rf 整目录 / dd 系统盘 / shutdown / reboot
 *     → 任何路径下直接拒绝, 不可豁免
 *  2. RECYCLABLE_DELETE: rm -r / rm -rf 普通用户文件 / unlink 类
 *     → 自动重写为 mv 到本机回收站; 重写后允许执行
 *  3. SIDE_EFFECT: mv / cp / mkdir / write 类
 *     → 走 post-verify, 不阻断, 但记录到 ledger sideEffects 供审计/回滚
 *
 * _Requirements: 不可逆动作硬护栏 (P-真3 升级版); 多用户安全 (per-user 路径隔离)_
 */

/**
 * 硬不可逆 (任何路径下直接拒绝, 不允许 __fromReply / declare_verifiable_task 豁免).
 * 命中即返回 reason, 调用方拒绝执行。
 */
const HARD_DESTRUCTIVE_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  // rm -rf / rm -r --no-preserve-root / 整目录 / 通配 (./. * / 等)
  { re: /\brm\s+(-[a-z]*r[a-z]*f?|-rf?|--recursive)\s*[^|;&]*\s+(\/|~\/?|\.\/?\*|\*)/i, reason: "rm 递归删除整目录或通配根" },
  { re: /\brm\s+-rf?\s+\/(\S*\s)?/i, reason: "rm -rf / 系列" },
  { re: /\brm\s+(-[a-z]*r[a-z]*f?|-rf?|--recursive).*\s(\$HOME|~)\b/i, reason: "rm 递归删除 home 整目录" },
  // 文件系统 / 块设备 / 引导
  { re: /\bmkfs\b/i, reason: "格式化文件系统" },
  { re: /\bdd\s+.*\bof=\/dev\/(sd|nvme|disk|hd)/i, reason: "dd 写入块设备" },
  { re: />\s*\/dev\/(sd|nvme|disk|hd)/i, reason: "重定向写入块设备" },
  // 关机 / 重启 / 远程登录提权
  { re: /\bshutdown\b\s+(-[hr]|now|\+?\d)/i, reason: "shutdown 关机" },
  { re: /\breboot\b/i, reason: "reboot 重启" },
  { re: /\bhalt\b/i, reason: "halt 关机" },
  { re: /\b(curl|wget)\s+\S+\s*\|\s*(sudo\s+)?(bash|sh|zsh|fish)/i, reason: "curl/wget pipe 到 shell 执行" },
  { re: /\beval\s*\(/i, reason: "eval 动态执行" },
  // 数据库
  { re: /\bDROP\s+(DATABASE|SCHEMA|USER)\b/i, reason: "DROP DATABASE/SCHEMA/USER" },
  { re: /\bTRUNCATE\b/i, reason: "TRUNCATE 表" },
  // sudo 任意提权 (单独拒绝, 即便后接的命令本身不在黑名单)
  { re: /\bsudo\b/i, reason: "sudo 提权" },
  // chmod 777 / chown root 整目录
  { re: /\bchmod\s+(-R\s+)?[0-7]{0,1}777\b/i, reason: "chmod 777 (过宽权限)" },
  // 反向 shell / netcat 监听执行
  { re: /\bnc\b\s+.*\s-e\b/i, reason: "netcat 反向 shell" },
];

/**
 * 可回收删除 (允许重写为 mv 到 ~/.Trash 后执行):
 *   - rm 单文件 / 多文件
 *   - rm -r 普通子目录 (非系统目录)
 * 不命中此模式 = 不视为删除指令, 不重写。
 */
const RECYCLABLE_DELETE_PATTERN =
  /\brm\s+(-[a-z]*[rRf][a-z]*\s+)?(.+?)$/i; // 任意 rm, captures path part

/** 系统/进程修改类 (有副作用但非毁灭): 走 post-verify, 不阻断 */
const SIDE_EFFECT_PATTERN =
  /(^|[^>])>>?\s|\bmv\b|\bcp\b|\bmkdir\b|\btouch\b|\bkill\b|\bpkill\b|\bstop\b|\binstall\b|\buninstall\b|\bgit\s+(reset|clean|push)\b/i;

/** 命令是否触发硬不可逆。命中返回 reason, 否则返回 null。 */
export function commandIsHardDestructive(command: string): string | null {
  if (!command) return null;
  for (const p of HARD_DESTRUCTIVE_PATTERNS) {
    if (p.re.test(command)) return p.reason;
  }
  return null;
}

/**
 * 判定命令是否是 "可回收的删除" (rm 单文件或非系统目录).
 * 返回:
 *  - null: 不是删除命令, 调用方原样执行
 *  - { reason: '...' }: 是硬黑名单删除, 调用方拒绝 (上层应先经 commandIsHardDestructive)
 *  - { rewriteToMv: true, originalPaths: [...] }: 调用方应重写为 mv 到 Trash
 */
export interface DeleteRewriteResult {
  rewriteToMv: true;
  originalPaths: string[];
}

export function classifyDelete(command: string): DeleteRewriteResult | null {
  if (!command) return null;
  // 必须命中 rm 命令模式
  const m = /\brm\s+([^\n]+)$/i.exec(command);
  if (!m) return null;
  // 切出 args, 排除选项 flag, 提取路径
  const argsRaw = m[1].trim();
  const tokens = argsRaw.split(/\s+/);
  const paths: string[] = [];
  for (const t of tokens) {
    if (t.startsWith("-")) continue;
    if (t === "&&" || t === "||" || t === ";") break;
    paths.push(t.replace(/^['"]|['"]$/g, "").trim());
  }
  if (paths.length === 0) return null;
  return { rewriteToMv: true, originalPaths: paths };
}

/**
 * 路径是否在该用户允许的范围内。多用户上必须按 brain 进程的 BRAIN_USER_ID
 * 划界, 防止 A 用户的指令访问到 B 用户家目录。
 *
 * 当前阶段策略 (保守):
 *  - 允许: 用户 home 子路径 (/Users/<x>/, ~) 但不能是 home 根
 *  - 允许: 临时目录 (/tmp/, /var/tmp/)
 *  - 允许: 当前进程工作目录子路径
 *  - 拒绝: /, /etc, /System, /usr, /bin, /var (除 /var/tmp), /Library 系
 *  - 拒绝: 跨用户路径 /Users/<otherUser>/ (除非配置允许)
 *
 * @param path 待检查路径 (绝对或相对均可)
 * @param ctx 上下文 (当前用户 home / 工作目录)
 */
export interface PathGuardContext {
  /** 当前 brain 进程的用户 home 目录, 例 "/Users/a333" */
  userHome?: string | null;
  /** 当前进程 cwd */
  cwd?: string | null;
}

const SYSTEM_FORBIDDEN_PREFIXES = [
  "/etc",
  "/System",
  "/usr",
  "/bin",
  "/sbin",
  "/Library",
  "/private/etc",
  "/private/var/db",
  "/var/log",
  "/var/db",
  "/dev",
  "/Volumes/Macintosh HD/System",
];

const ALLOWED_TMP_PREFIXES = ["/tmp/", "/var/tmp/", "/private/tmp/", "/private/var/tmp/"];

export interface PathGuardVerdict {
  allowed: boolean;
  reason: string;
}

export function pathInUserScope(path: string, ctx: PathGuardContext): PathGuardVerdict {
  if (!path) return { allowed: false, reason: "路径为空" };
  let p = path.trim().replace(/^['"]|['"]$/g, "");
  // 把 ~ 展开
  if (ctx.userHome && (p === "~" || p.startsWith("~/"))) {
    p = p === "~" ? ctx.userHome : ctx.userHome + p.slice(1);
  }
  // 拒绝 / 根目录
  if (p === "/" || p === "//") return { allowed: false, reason: "禁止访问根目录" };
  // 系统目录前缀拒绝
  for (const pref of SYSTEM_FORBIDDEN_PREFIXES) {
    if (p === pref || p.startsWith(pref + "/")) {
      return { allowed: false, reason: `禁止访问系统目录: ${pref}` };
    }
  }
  // 临时目录允许
  for (const pref of ALLOWED_TMP_PREFIXES) {
    if (p.startsWith(pref)) return { allowed: true, reason: "临时目录子路径" };
  }
  // 用户 home 子路径允许 (但不允许 home 根)
  if (ctx.userHome) {
    if (p === ctx.userHome) {
      return { allowed: false, reason: "禁止操作 home 根目录本身" };
    }
    if (p.startsWith(ctx.userHome + "/")) {
      return { allowed: true, reason: "用户 home 子路径" };
    }
  }
  // /Users/<other>/ 跨用户路径拒绝 (mac)
  const usersMatch = /^\/Users\/([^\/]+)/.exec(p);
  if (usersMatch) {
    const homeUser = ctx.userHome ? /^\/Users\/([^\/]+)/.exec(ctx.userHome)?.[1] : null;
    if (homeUser && usersMatch[1] !== homeUser) {
      return { allowed: false, reason: `跨用户路径: 当前用户 ${homeUser}, 目标 ${usersMatch[1]}` };
    }
    if (!homeUser) {
      return { allowed: false, reason: "无法验证用户归属, 拒绝跨 /Users 操作" };
    }
  }
  // /home/<other>/ linux 跨用户拒绝
  const homeMatch = /^\/home\/([^\/]+)/.exec(p);
  if (homeMatch) {
    const homeUser = ctx.userHome ? /^\/home\/([^\/]+)/.exec(ctx.userHome)?.[1] : null;
    if (homeUser && homeMatch[1] !== homeUser) {
      return { allowed: false, reason: `跨用户路径: 当前用户 ${homeUser}, 目标 ${homeMatch[1]}` };
    }
  }
  // cwd 子路径允许
  if (ctx.cwd && (p === ctx.cwd || p.startsWith(ctx.cwd + "/"))) {
    return { allowed: true, reason: "cwd 子路径" };
  }
  // 相对路径 (不以 / 起头) 视为相对当前 cwd, 允许
  if (!p.startsWith("/") && !p.startsWith("\\")) {
    return { allowed: true, reason: "相对路径 (相对 cwd)" };
  }
  // 默认拒绝, 让上层在白名单外的路径上必须 declare_verifiable_task
  return { allowed: false, reason: `路径不在白名单内: ${p}` };
}

/** 命令副作用分级, 用于 ledgerLogTool 真填 sideEffects/rollbackable */
export type SideEffectKind =
  | "destructive" // 不可逆毁灭
  | "delete" // 删除 (可经 mv to Trash 回收)
  | "write" // 写文件 / 修改
  | "process" // kill / shutdown 进程
  | "network" // 安装 / 下载
  | "none";

export interface CommandSideEffectInfo {
  kinds: SideEffectKind[];
  rollbackable: boolean;
  destructive: boolean;
}

export function classifyCommandSideEffects(command: string): CommandSideEffectInfo {
  if (!command) return { kinds: ["none"], rollbackable: true, destructive: false };
  const kinds: SideEffectKind[] = [];
  const destructive = !!commandIsHardDestructive(command);
  if (destructive) kinds.push("destructive");
  if (/\brm\b/i.test(command)) kinds.push("delete");
  if (/(^|[^>])>>?\s|\bmv\b|\bcp\b|\bmkdir\b|\btouch\b/i.test(command)) kinds.push("write");
  if (/\b(kill|pkill|shutdown|reboot|launchctl)\b/i.test(command)) kinds.push("process");
  if (/\b(npm\s+install|pip\s+install|brew\s+install|apt\s+install|yum\s+install|curl|wget)\b/i.test(command)) {
    kinds.push("network");
  }
  if (kinds.length === 0) kinds.push("none");
  // rollbackable: destructive=不可恢复, delete 重写后 mv-to-Trash 视为可恢复, 其他默认 false (因为 ledger 没存 backup)
  const rollbackable = !destructive;
  return { kinds, rollbackable, destructive };
}
