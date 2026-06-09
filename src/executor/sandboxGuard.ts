/**
 * Working_Directory sandbox 越界校验（任务 11.1，安全关键，R12.2 / R12.4）。
 *
 * `SandboxGuard` 把 Executor 的所有文件/命令路径限定在 Working_Directory 范围内。
 * 原始字符串层面的越界判定（`path.resolve` + `path.relative`）**无法防御符号链接逃逸**：
 * sandbox 内一个指向外部的软链会让 `resolve` 后的字符串"看似在内"，实际读写却落到
 * sandbox 外。因此本实现一律用**真实路径（realpath）解析后再判定**：
 *  - 构造时对根做 `fs.realpathSync` 规范化（解析根路径上的所有符号链接）；
 *  - `isInside` 对目标解析全部符号链接后再判定——已存在路径用 `realpathSync`，
 *    待创建路径用"最近已存在父目录的 realpath + 剩余路径段"，从而即便父链中含软链
 *    也能被正确解析、防止"借父目录软链逃逸"。
 *
 * 实例化时机约束（R9.4 / R12）：`SandboxGuard` **必须在 Scope_Resolver 确认
 * Working_Directory 之后才实例化**——即 Executor 收到 Working_Directory 之后。
 * 为此提供 {@link SandboxGuard.createForDir} 工厂方法（接受已确认的 Working_Directory），
 * 作为推荐入口；同时保留接受根绝对路径字符串的构造函数供执行循环内部使用。
 *
 * _Requirements: 12.2, 12.4_
 */

import fs from "node:fs";
import path from "node:path";

/**
 * 已确认的 Working_Directory 的最小结构契约（sandbox 根）。
 *
 * 与 `scope/scopeResolver.ts`（任务 9.1）将导出的 `WorkingDirectory` 结构一致
 * （`{ rootAbsPath: string }`），TypeScript 结构化类型下可直接互换传入；此处用
 * 结构化类型声明，避免在 scope 模块落地前产生跨模块类型依赖。
 */
export interface WorkingDirectoryLike {
  /** 规范化后的绝对路径（sandbox 根）。 */
  rootAbsPath: string;
}

/**
 * Working_Directory sandbox 越界校验器（realpath 解析，含符号链接逃逸防御）。
 */
export class SandboxGuard {
  /** realpath 规范化后的 sandbox 根（解析了根路径上的所有符号链接）。 */
  private readonly root: string;

  /**
   * 用 sandbox 根的绝对路径构造。构造时即对根做 realpath 规范化。
   *
   * 推荐通过 {@link SandboxGuard.createForDir} 在 Working_Directory 确认后实例化；
   * 本构造函数供执行循环内部（已持有 `rootAbsPath`）直接使用。
   *
   * @param rootAbsPath sandbox 根的绝对路径（须为已确认的 Working_Directory 根）。
   * @throws 当根路径不存在/不可访问时由 `fs.realpathSync` 抛出（实例化前 Working_Directory 应已校验存在）。
   */
  constructor(rootAbsPath: string) {
    this.root = fs.realpathSync(path.resolve(rootAbsPath));
  }

  /**
   * 工厂方法：在 Scope_Resolver 确认 Working_Directory **之后**创建 SandboxGuard
   * （R9.4 / R12 实例化时机约束）。
   *
   * @param workingDir 已确认的 Working_Directory（提供 sandbox 根 `rootAbsPath`）。
   * @returns 以该目录为根、且根已 realpath 规范化的 `SandboxGuard` 实例。
   */
  static createForDir(workingDir: WorkingDirectoryLike): SandboxGuard {
    return new SandboxGuard(workingDir.rootAbsPath);
  }

  /** 返回规范化后的 sandbox 根（realpath 后），主要用于诊断与工具自校验。 */
  get rootRealPath(): string {
    return this.root;
  }

  /**
   * 解析 `target` 的真实绝对路径后，判断其是否在规范化后的根内（含根本身）。
   *
   * 判定步骤：
   *  1. 以根为基准把 `target` 解析为绝对路径（相对路径相对 sandbox 根）；
   *  2. 对该绝对路径求真实路径（解析全部符号链接，含待创建路径的父链软链）；
   *  3. 计算其相对根的相对路径：为空（即根本身）或不以 `..` 开头且非绝对 → 在内。
   *
   * 覆盖的越界形态：`..` 路径穿越、绝对路径逃逸、以及**经符号链接指向根外**的路径。
   *
   * @param target 待校验路径（绝对或相对 sandbox 根）。
   * @returns `true` 表示解析后位于 sandbox 内（含根本身）；`false` 表示越界。
   */
  isInside(target: string): boolean {
    const real = this.resolveReal(path.resolve(this.root, target));
    const rel = path.relative(this.root, real);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  }

  /**
   * 对（可能尚不存在的）路径求真实绝对路径。
   *
   * 自底向上找到最近的**已存在**祖先，对其做 `realpathSync`（解析其路径上的全部
   * 符号链接），再把不存在的剩余路径段拼回。如此即便待创建路径的父链中含软链，
   * 也能被正确解析，防止"借父目录软链逃逸"。
   *
   * @param absPath 已 `path.resolve` 的绝对路径。
   * @returns 真实绝对路径（已解析符号链接）。
   */
  private resolveReal(absPath: string): string {
    let existing = absPath;
    const tail: string[] = [];
    while (!fs.existsSync(existing)) {
      tail.unshift(path.basename(existing));
      const parent = path.dirname(existing);
      if (parent === existing) break; // 抵达文件系统根
      existing = parent;
    }
    const realExisting = fs.realpathSync(existing);
    return tail.length > 0 ? path.join(realExisting, ...tail) : realExisting;
  }
}
