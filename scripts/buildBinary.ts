/**
 * 单二进制打包脚本（任务 17.5 / _Requirements: 16.1, 16.4, 17.1_）。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 这是什么
 * ─────────────────────────────────────────────────────────────────────────────
 * 用 `bun build --compile` 把「运行时 + 代码 + 依赖」编译成**单个可执行文件**，
 * 让没有 Node/开发环境的人也能零依赖双击运行。经 `npm run build:binary` 调用
 * （= `tsx scripts/buildBinary.ts`）。入口为 `src/index.ts`，产物输出到 `dist-bin/`。
 *
 * 这是**发布收尾动作**：
 *   - 不参与日常开发（日常用 `npm start` / 双击 `启动.command`）。
 *   - 二进制是「某一时刻代码的快照」，每次发新版都需要重新打包。
 *   - 产物较大（约 60–110MB，因为内嵌了整个 JS 运行时），可 `zip` 后分发。
 *
 * 不改变运行期架构与安全边界：编译产物与 `npm start` 跑的是同一份 `src/index.ts`，
 * 仍只绑定 `127.0.0.1`（仅本机可达），除 LLM API 外不向任何远程服务委托扫描/执行。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * public/ 静态资源如何随产物分发与定位
 * ─────────────────────────────────────────────────────────────────────────────
 * 运行期的 `HttpWebServer` 默认从「启动时的工作目录」下的 `public/` 提供静态资源
 * （见 `src/server/webServer.ts` 的 `DEFAULT_PUBLIC_DIR = resolve(process.cwd(), "public")`）。
 * 单文件二进制无法把 `public/` 透明地“塞进”这套基于 `process.cwd()` 的查找逻辑，
 * 因此本脚本**把 `public/` 一并复制到二进制旁边**（`dist-bin/public/`），并约定：
 *
 *     >>> 运行二进制时，请先 cd 进 dist-bin/（或从 dist-bin/ 目录里启动），<<<
 *     >>> 这样 process.cwd() 就能定位到同目录下的 public/。            <<<
 *
 * 脚本会在 `dist-bin/` 内额外生成一份「发布说明.txt」，把上述用法写清楚，
 * 并提示可将整个 `dist-bin/` 目录 `zip` 后分发。如此既不改运行期架构，也不动安全边界。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 回退指引（bun 不可用时——绝不静默失败）
 * ─────────────────────────────────────────────────────────────────────────────
 * 若本机检测不到 bun，脚本会打印清晰的回退指引并以非零码退出：
 *   - 推荐：安装 bun（https://bun.sh ；macOS 亦可 `brew install oven-sh/bun/bun`），再重跑；
 *   - 备选：Node 单可执行应用（SEA, https://nodejs.org/api/single-executable-applications.html）
 *           需先 `npm run build` 产出 `dist/index.js`，再按官方步骤注入 blob；
 *   - 备选：`pkg`（https://github.com/vercel/pkg ，已进入维护期）。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 用法
 * ─────────────────────────────────────────────────────────────────────────────
 *   npm run build:binary               # 正式打包，产出 dist-bin/<name>
 *   npm run build:binary -- --dry-run  # 仅探测 bun 并打印计划，不实际编译（无产物）
 *   npm run build:binary -- --name foo # 自定义产物文件名（默认 proactive-awareness-demo）
 *   npm run build:binary -- --out out  # 自定义输出目录（默认 dist-bin）
 */

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ===========================================================================
// 常量与类型
// ===========================================================================

/** 产物默认输出目录（相对仓库根）。 */
const DEFAULT_OUT_DIR = "dist-bin";

/** 产物默认文件名（不含平台后缀）。 */
const DEFAULT_BIN_NAME = "proactive-awareness-demo";

/** 入口源文件（相对仓库根）。 */
const ENTRY_SOURCE = "src/index.ts";

/** 需随产物分发的静态资源目录（相对仓库根）。 */
const PUBLIC_DIR_NAME = "public";

/** 解析后的命令行选项。 */
interface BuildOptions {
  /** 仅探测并打印计划、不实际编译（不产出二进制）。 */
  dryRun: boolean;
  /** 输出目录（相对仓库根）。 */
  outDir: string;
  /** 产物文件名（不含平台后缀）。 */
  binName: string;
}

// ===========================================================================
// 入口
// ===========================================================================

void main();

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const projectRoot = findProjectRoot();

  printHeader(opts);

  // 1) 探测 bun 是否可用；不可用则打印回退指引并优雅退出（不静默失败）。
  const bunVersion = probeBun();
  if (bunVersion === null) {
    printBunUnavailableGuidance();
    process.exitCode = 1;
    return;
  }
  console.log(`✓ 已检测到 bun v${bunVersion}\n`);

  const entryAbs = resolve(projectRoot, ENTRY_SOURCE);
  if (!existsSync(entryAbs)) {
    console.error(`✗ 找不到入口源文件：${entryAbs}`);
    console.error("  请确认在仓库根（wenLuDemo）下运行本脚本，且 17.1 composition root 已就位。");
    process.exitCode = 1;
    return;
  }

  const outDirAbs = resolve(projectRoot, opts.outDir);
  const binName = platformBinName(opts.binName);
  const binPathAbs = join(outDirAbs, binName);

  // 2) dry-run：只打印计划，不动文件系统、不编译。
  if (opts.dryRun) {
    console.log("— dry-run：仅打印计划，不实际编译，无产物 —");
    console.log(`  入口    : ${entryAbs}`);
    console.log(`  产物    : ${binPathAbs}`);
    console.log(`  静态资源: ${resolve(projectRoot, PUBLIC_DIR_NAME)} → ${join(outDirAbs, PUBLIC_DIR_NAME)}`);
    console.log(`  将执行  : ${describeBuildCommand(entryAbs, binPathAbs)}`);
    console.log("\n✓ dry-run 完成（未产出二进制）。去掉 --dry-run 即可正式打包。");
    return;
  }

  // 3) 准备干净的输出目录。
  prepareOutDir(outDirAbs);

  // 4) 调用 bun build --compile 编译为单可执行文件。
  console.log("→ 正在编译单二进制（内嵌运行时，耗时较久，请稍候）……");
  console.log(`  ${describeBuildCommand(entryAbs, binPathAbs)}\n`);
  const ok = runBunCompile(projectRoot, entryAbs, binPathAbs);
  if (!ok) {
    console.error("\n✗ 打包失败：bun build --compile 未成功结束。请检查上方 bun 的输出。");
    process.exitCode = 1;
    return;
  }
  if (!existsSync(binPathAbs)) {
    console.error(`\n✗ 打包异常：未在预期路径找到产物 ${binPathAbs}。`);
    process.exitCode = 1;
    return;
  }

  // 5) 复制 public/ 到产物旁，并写发布说明，解决静态资源定位问题。
  copyPublicAssets(projectRoot, outDirAbs);
  writeReleaseNotes(outDirAbs, binName);

  // 6) 打印产物路径与大小、收尾提示。
  printSummary(binPathAbs, binName, opts.outDir);
}

// ===========================================================================
// 命令行解析
// ===========================================================================

/** 解析命令行参数为 {@link BuildOptions}（未知参数忽略，缺省走默认值）。 */
function parseArgs(argv: readonly string[]): BuildOptions {
  const opts: BuildOptions = {
    dryRun: false,
    outDir: DEFAULT_OUT_DIR,
    binName: DEFAULT_BIN_NAME,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run" || arg === "--check") {
      opts.dryRun = true;
    } else if (arg === "--out" || arg === "--out-dir") {
      const value = argv[i + 1];
      if (value && !value.startsWith("--")) {
        opts.outDir = value;
        i += 1;
      }
    } else if (arg === "--name") {
      const value = argv[i + 1];
      if (value && !value.startsWith("--")) {
        opts.binName = value;
        i += 1;
      }
    }
  }

  return opts;
}

// ===========================================================================
// bun 探测与编译
// ===========================================================================

/** 探测 bun 是否可用：返回版本号字符串（如 `1.1.34`），不可用返回 `null`。 */
function probeBun(): string | null {
  try {
    const result = spawnSync("bun", ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error || result.status !== 0 || typeof result.stdout !== "string") {
      return null;
    }
    const version = result.stdout.trim();
    return version.length > 0 ? version : null;
  } catch {
    return null;
  }
}

/** 拼出可读的编译命令（用于日志/计划展示）。 */
function describeBuildCommand(entryAbs: string, binPathAbs: string): string {
  return `bun build ${entryAbs} --compile --outfile ${binPathAbs}`;
}

/**
 * 调用 `bun build --compile` 真正编译为单可执行文件。
 * 用 `stdio: "inherit"` 把 bun 的进度直接透传到当前终端。返回是否成功。
 */
function runBunCompile(cwd: string, entryAbs: string, binPathAbs: string): boolean {
  const result = spawnSync(
    "bun",
    ["build", entryAbs, "--compile", "--outfile", binPathAbs],
    { cwd, stdio: "inherit" },
  );
  return !result.error && result.status === 0;
}

// ===========================================================================
// 文件系统：输出目录、静态资源、发布说明
// ===========================================================================

/** 清空并重建输出目录，确保每次打包是干净快照。 */
function prepareOutDir(outDirAbs: string): void {
  if (existsSync(outDirAbs)) {
    rmSync(outDirAbs, { recursive: true, force: true });
  }
  mkdirSync(outDirAbs, { recursive: true });
}

/** 把仓库根的 `public/` 递归复制到产物旁（`<outDir>/public/`）。 */
function copyPublicAssets(projectRoot: string, outDirAbs: string): void {
  const src = resolve(projectRoot, PUBLIC_DIR_NAME);
  const dest = join(outDirAbs, PUBLIC_DIR_NAME);
  if (!existsSync(src)) {
    console.warn(`! 警告：未找到 ${src}，跳过静态资源复制（前端界面可能无法加载）。`);
    return;
  }
  cpSync(src, dest, { recursive: true });
  console.log(`✓ 已复制静态资源：${src} → ${dest}`);
}

/** 在产物目录写一份发布说明，讲清运行方式与 public/ 定位约定、安全边界。 */
function writeReleaseNotes(outDirAbs: string, binName: string): void {
  const notesPath = join(outDirAbs, "发布说明.txt");
  const notes = [
    "问路 · 主动察觉 demo —— 单二进制发布说明",
    "==========================================",
    "",
    "本目录由 `npm run build:binary` 生成，是某一时刻代码的快照（发布收尾产物）。",
    "",
    "【如何运行】",
    `  1. 打开终端，cd 进入本目录（重要：要从本目录启动，二进制才能定位到同级的 public/）：`,
    `       cd "<解压后的本目录路径>"`,
    `  2. 运行可执行文件：`,
    `       ./${binName}`,
    `  3. 终端会打印 http://127.0.0.1:8787 ，用浏览器打开即可（端口可用环境变量 PORT 覆盖）。`,
    "",
    "【为什么要从本目录启动】",
    "  二进制内嵌了运行时与代码，但前端静态资源仍按「启动时工作目录下的 public/」查找，",
    "  因此 public/ 被一并放在本目录。从本目录启动可让 process.cwd() 正确定位到 public/。",
    "",
    "【分发方式】",
    "  把整个本目录（含可执行文件与 public/）打包成 zip 后发给对方即可，无需安装 Node。",
    "  产物较大（约 60–110MB）属正常：内嵌了完整 JS 运行时。",
    "",
    "【安全边界（与 npm start 完全一致，未改变）】",
    "  - 服务仅绑定 127.0.0.1，仅本机可达；",
    "  - 除调用 LLM API 外，不向任何远程服务器委托扫描或任务执行。",
    "",
    "【发版提醒】",
    "  二进制不参与日常开发；每次发新版都需重新执行 `npm run build:binary` 重新打包。",
    "",
  ].join("\n");
  writeFileSync(notesPath, notes, "utf8");
  console.log(`✓ 已写入发布说明：${notesPath}`);
}

// ===========================================================================
// 工具函数
// ===========================================================================

/** 推断仓库根：脚本位于 `<root>/scripts/`，向上一级即仓库根。 */
function findProjectRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..");
}

/** 按平台给产物文件名加后缀（Windows 加 `.exe`，其余不加）。 */
function platformBinName(base: string): string {
  return process.platform === "win32" ? `${base}.exe` : base;
}

/** 把字节数格式化为带单位的可读字符串。 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

// ===========================================================================
// 打印
// ===========================================================================

/** 打印脚本头部说明（发布收尾动作 + 安全边界提示）。 */
function printHeader(opts: BuildOptions): void {
  console.log("════════════════════════════════════════════════════════════");
  console.log(" 问路 · 主动察觉 demo —— 单二进制打包（build:binary）");
  console.log("════════════════════════════════════════════════════════════");
  console.log(" 这是发布收尾动作：不参与日常开发，每次发新版需重新打包。");
  console.log(" 产物约 60–110MB（内嵌运行时）；不改变运行期架构与安全边界");
  console.log(" （仍绑定 127.0.0.1，除 LLM API 外不向远程委托）。");
  if (opts.dryRun) {
    console.log(" 模式：--dry-run（仅探测与计划，不实际编译）。");
  }
  console.log("────────────────────────────────────────────────────────────");
}

/** bun 不可用时打印清晰的回退指引（绝不静默失败）。 */
function printBunUnavailableGuidance(): void {
  console.error("✗ 未检测到 bun，无法用 `bun build --compile` 打包单二进制。\n");
  console.error("请选择以下任一方式后重试：\n");
  console.error("  [推荐] 安装 bun，再重跑 `npm run build:binary`：");
  console.error("         curl -fsSL https://bun.sh/install | bash");
  console.error("         （macOS 亦可：brew install oven-sh/bun/bun）\n");
  console.error("  [备选] Node 单可执行应用（SEA）：先 `npm run build` 产出 dist/index.js，");
  console.error("         再按官方文档注入 blob：");
  console.error("         https://nodejs.org/api/single-executable-applications.html\n");
  console.error("  [备选] 使用 pkg（已进入维护期）：");
  console.error("         https://github.com/vercel/pkg\n");
  console.error("注意：日常开发与本机演示无需打包——直接 `npm start` 或双击 `启动.command` 即可。");
}

/** 打印产物路径、大小与收尾提示。 */
function printSummary(binPathAbs: string, binName: string, outDir: string): void {
  let sizeText = "未知";
  try {
    sizeText = formatBytes(statSync(binPathAbs).size);
  } catch {
    // 取大小失败不影响主流程，已成功产出二进制。
  }

  console.log("\n════════════════════════════════════════════════════════════");
  console.log("✓ 打包完成");
  console.log("────────────────────────────────────────────────────────────");
  console.log(`  产物路径 : ${binPathAbs}`);
  console.log(`  产物大小 : ${sizeText}`);
  console.log(`  运行方式 : cd ${outDir} && ./${binName}（务必从该目录启动以定位 public/）`);
  console.log(`  分发方式 : 将整个 ${outDir}/ 目录 zip 后发出，对方无需安装 Node。`);
  console.log("  安全边界 : 与 npm start 一致——仅绑定 127.0.0.1，除 LLM API 外不向远程委托。");
  console.log("  发版提醒 : 二进制是代码快照，每次发新版需重新执行 build:binary。");
  console.log("════════════════════════════════════════════════════════════");
}
