/**
 * Scope_Resolver 定界（任务 9.1，R9）。
 *
 * 职责：
 *  - `suggest`：基于 `Task_Frame` 与 `Scan_Summary` 证据，推断一个**建议**的工作目录
 *    （优先取与任务关联的 git 仓库根，否则取证据文件的公共父目录）。该值仅为建议，
 *    最终以用户确认/改写为准（R9.1/R9.3）。
 *  - `isCriticalDir`（纯函数）：把候选路径规范化后与「关键目录黑名单」逐一比较，
 *    命中即视为过宽/过敏感目录（R9.2，安全关键）。
 *  - `confirm`：把用户最终指定的路径规范化为 sandbox 根（`rootAbsPath`），命中关键目录
 *    黑名单则抛 `ScopeError`，绝不落定（R9.2/R9.3）。
 *
 * 安全背景（对抗性审查后新增，R9）：若把 `~`（用户主目录本身）、`/`、`/Users`、`/home`
 * 等过宽/过敏感的根目录设为 Working_Directory，备份将扫描海量文件导致体积爆炸，且
 * Executor 操作面过大。因此 `confirm` 在落定前必须先做关键目录黑名单校验。
 *
 * 实例化与状态机约束（R9.4）：本模块只负责「推断 + 落定 Working_Directory」；
 * 「Working_Directory 确认之前不进入执行」由 Orchestrator 状态机强制，不在此实现。
 *
 * _Requirements: 9.1, 9.2, 9.3, 9.4_
 */

import fs from "node:fs";
import path from "node:path";

import { CRITICAL_DIR_BLACKLIST } from "../config/config.js";
import type { Task_Frame } from "../clarifier/types.js";
import type { Scan_Summary } from "../scanner/types.js";

// ===========================================================================
// 类型与错误
// ===========================================================================

/**
 * 已确认的工作目录（sandbox 根）。
 *
 * 结构与 `executor/sandboxGuard.ts` 的 `WorkingDirectoryLike`（`{ rootAbsPath: string }`）
 * 一致：TypeScript 结构化类型下二者可直接互换传入 `SandboxGuard.createForDir`。
 */
export interface WorkingDirectory {
  /** 规范化后的绝对路径（sandbox 根）。 */
  rootAbsPath: string;
}

/**
 * 定界阶段的描述性错误（非致命，R9）。
 *
 * 抛出场景：用户指定路径命中关键目录黑名单；或（开启存在性校验时）路径不存在/不可访问。
 * 由编排层捕获后转 `error` 状态并提示用户另选目录，服务保持可运行。
 */
export class ScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScopeError";
  }
}

/**
 * Scope_Resolver 接口契约（design.md「Scope_Resolver（R9）」）。
 */
export interface Scope_Resolver {
  /** 基于 Task_Frame 推断建议工作目录（结合 Scan_Summary 证据中的路径）。 */
  suggest(taskFrame: Task_Frame, summary: Scan_Summary): Promise<string>;

  /**
   * 用户确认/修改后落定 Working_Directory，作为 sandbox 根目录。
   * @throws ScopeError 命中关键目录黑名单（或开启存在性校验且路径不存在/非目录）。
   */
  confirm(userChosenPath: string): WorkingDirectory;
}

// ===========================================================================
// 纯函数：关键目录判定（R9.2，安全关键）
// ===========================================================================

/**
 * 判断 `absPath` 规范化后是否**精确命中**关键目录黑名单之一（纯函数）。
 *
 * 比较方式：两侧均经 `path.resolve` 规范化后做字符串相等比较——只拦截"把黑名单目录
 * **本身**设为工作目录"的情形（如 `/`、`/Users`、用户主目录本身），不拦截黑名单目录
 * **下属的聚焦子目录**（如 `~/projects/foo` 不命中 `~`），以免过度限制正常使用。
 *
 * @param absPath 候选路径（绝对或相对，内部统一 `path.resolve` 规范化）。
 * @param blacklist 关键目录黑名单（逐项 `path.resolve` 后比较）。
 * @returns 命中任一黑名单目录返回 `true`，否则 `false`。
 */
export function isCriticalDir(absPath: string, blacklist: string[]): boolean {
  const norm = path.resolve(absPath);
  return blacklist.some((b) => path.resolve(b) === norm);
}

// ===========================================================================
// 内部辅助（建议目录推断）
// ===========================================================================

/** `ancestor` 是否为 `descendant` 的祖先目录或与之相等（规范化后判定）。 */
function isAncestorOrEqual(ancestor: string, descendant: string): boolean {
  const a = path.resolve(ancestor);
  const d = path.resolve(descendant);
  if (a === d) return true;
  const rel = path.relative(a, d);
  return rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * 计算一组绝对路径的公共父目录（最长公共路径段前缀）。
 *  - 空集合返回 `null`；
 *  - 单一路径返回其所在目录（`dirname`，因证据多为文件路径）；
 *  - 多路径返回最长公共段前缀；仅共享文件系统根时返回 `path.sep`。
 */
function commonParentDir(paths: string[]): string | null {
  const resolved = paths.map((p) => path.resolve(p));
  if (resolved.length === 0) return null;
  if (resolved.length === 1) return path.dirname(resolved[0]);

  const segLists = resolved.map((p) => p.split(path.sep));
  const minLen = Math.min(...segLists.map((s) => s.length));
  const common: string[] = [];
  for (let i = 0; i < minLen; i++) {
    const seg = segLists[0][i];
    if (segLists.every((s) => s[i] === seg)) {
      common.push(seg);
    } else {
      break;
    }
  }
  const joined = common.join(path.sep);
  // 全为绝对路径时首段为空串，join 后以分隔符开头；仅共享根则退化为 path.sep。
  return joined === "" ? path.sep : joined;
}

// ===========================================================================
// 默认实现
// ===========================================================================

/** `DefaultScopeResolver` 构造选项。 */
export interface ScopeResolverOptions {
  /** 关键目录黑名单，默认取 `config.ts` 的 `CRITICAL_DIR_BLACKLIST`（可注入便于测试）。 */
  criticalDirBlacklist?: string[];
  /**
   * 是否在 `confirm` 时校验路径存在且为目录（对应 design @throws 的"路径不存在/不可访问"）。
   * 默认 `false`——保持 `confirm` 为纯粹的"规范化 + 关键目录黑名单"安全门，便于属性测试在
   * 任意生成路径上确定性验证；真实编排层（Orchestrator）可置 `true` 叠加文件系统校验。
   */
  validatePathExists?: boolean;
}

/**
 * `Scope_Resolver` 的默认实现。
 */
export class DefaultScopeResolver implements Scope_Resolver {
  private readonly criticalDirBlacklist: string[];
  private readonly validatePathExists: boolean;

  constructor(options?: ScopeResolverOptions) {
    this.criticalDirBlacklist = options?.criticalDirBlacklist ?? CRITICAL_DIR_BLACKLIST;
    this.validatePathExists = options?.validatePathExists ?? false;
  }

  /**
   * 推断建议工作目录（R9.1）：
   *  1. `Task_Frame.suggestedWorkingDirHint` 显式给出 → 直接采用（规范化）。
   *  2. 存在绝对路径形态的 `primaryTargets` 时：优先取**包含全部目标**的最高分 git 仓库根；
   *     否则取这些目标的公共父目录。
   *  3. 无可用目标时：取证据中得分最高的 git 仓库根。
   *  4. 再退化为证据文件路径的公共父目录。
   *  5. 兜底返回当前工作目录（仅为建议，最终由用户确认 + `confirm` 校验把关）。
   *
   * 注：返回值是**建议**，可能仍是关键目录；真正的安全把关在 `confirm`。
   */
  async suggest(taskFrame: Task_Frame, summary: Scan_Summary): Promise<string> {
    // 1) 显式 hint 优先
    const hint = taskFrame.suggestedWorkingDirHint?.trim();
    if (hint) return path.resolve(hint);

    // 收集证据：git 仓库根（带分）、文件证据路径
    const gitRoots = summary.items
      .filter((i) => i.kind === "git" && typeof i.git?.repoPath === "string")
      .map((i) => ({ root: path.resolve(i.git!.repoPath), score: i.score }));

    const fileEvidencePaths = summary.items
      .filter((i) => i.kind === "file" && typeof i.file?.path === "string")
      .map((i) => path.resolve(i.file!.path));

    // primaryTargets 中仅取绝对路径形态者（可能含"项目名"等非路径项，过滤掉）
    const targetPaths = (taskFrame.primaryTargets ?? [])
      .filter((t): t is string => typeof t === "string" && path.isAbsolute(t))
      .map((t) => path.resolve(t));

    // 2) 优先 git 根：包含全部 primaryTargets 的最高分 git 仓库根
    if (targetPaths.length > 0 && gitRoots.length > 0) {
      const containing = gitRoots
        .filter((g) => targetPaths.every((p) => isAncestorOrEqual(g.root, p)))
        .sort((a, b) => b.score - a.score)[0];
      if (containing) return containing.root;
    }

    // 2b) primaryTargets 的公共父目录
    if (targetPaths.length > 0) {
      const cp = commonParentDir(targetPaths);
      if (cp) return cp;
    }

    // 3) 无目标：得分最高的 git 仓库根
    if (gitRoots.length > 0) {
      return [...gitRoots].sort((a, b) => b.score - a.score)[0].root;
    }

    // 4) 证据文件的公共父目录
    if (fileEvidencePaths.length > 0) {
      const cp = commonParentDir(fileEvidencePaths);
      if (cp) return cp;
    }

    // 5) 兜底：当前工作目录（仅为建议，最终由用户确认 + confirm 校验）
    return process.cwd();
  }

  /**
   * 落定 Working_Directory（R9.2/R9.3）：
   *  1. `path.resolve` 规范化用户最终指定路径为绝对路径。
   *  2. 命中关键目录黑名单 → 抛 `ScopeError`（绝不落定，安全门）。
   *  3. （可选，`validatePathExists` 开启时）校验路径存在且为目录，否则抛 `ScopeError`。
   *  4. 返回 `{ rootAbsPath }` 作为 sandbox 根。
   *
   * 不论用户是接受建议还是拒绝后改写，最终都以**用户指定值**的规范化绝对路径落定（R9.3）。
   */
  confirm(userChosenPath: string): WorkingDirectory {
    const rootAbsPath = path.resolve(userChosenPath);

    // 安全门：关键/过宽目录一律拒绝（R9.2）
    if (isCriticalDir(rootAbsPath, this.criticalDirBlacklist)) {
      throw new ScopeError(
        `拒绝把关键或过宽目录设为 Working_Directory：${rootAbsPath}。` +
          `此类目录作为 sandbox 根会导致备份体积爆炸、Executor 操作面过大，请另选更聚焦的子目录。`,
      );
    }

    // 可选：路径存在性/可访问性校验（默认关闭，便于属性测试；编排层可开启）
    if (this.validatePathExists) {
      try {
        const stat = fs.statSync(rootAbsPath);
        if (!stat.isDirectory()) {
          throw new ScopeError(`Working_Directory 必须是一个已存在的目录：${rootAbsPath}。`);
        }
      } catch (err) {
        if (err instanceof ScopeError) throw err;
        throw new ScopeError(`Working_Directory 路径不存在或不可访问：${rootAbsPath}。`);
      }
    }

    return { rootAbsPath };
  }
}
