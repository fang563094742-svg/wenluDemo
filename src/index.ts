/**
 * proactive-awareness-demo —— composition root（任务 17.1）。
 *
 * 设计依据：design.md「Architecture → 分层与可插拔点」「Components and Interfaces →
 * 0. 可插拔注册表」「7. Web 服务与对话界面」，以及「Gpt54Provider → 启动校验」。
 *
 * 职责（正式装配根）：
 *  1. **API key 启动校验（R6.4）**：用 `validateApiKey` 校验 GPT-5.4 API key，缺失则打印
 *     描述性错误并**优雅终止启动**（设置 `process.exitCode=1` 后返回，绝不抛未捕获异常、
 *     不崩溃）。注入了自定义 `llmProvider`（如测试 mock）时跳过该校验。
 *  2. **装配三大可插拔注册表（R17.2/R17.3）**：
 *      - `scannerRegistry`：`register("darwin", new MacScanner())`（按平台 key）。
 *      - `providerRegistry`：`register(provider.providerKey, provider)`（按 provider key）。
 *      - `toolRegistry`：`createToolRegistry()`（按 tool name）。
 *  3. **按 `process.platform` 分派 Scanner（R2.3/R2.5）**：从 `scannerRegistry` 解析当前
 *     平台扫描器；非 macOS 平台给"暂不支持扫描"提示并退化为 `UnsupportedScanner`
 *     （`isSupported()===false`），服务仍可启动、扫描动作经 Orchestrator 优雅返回提示而**不崩溃**。
 *  4. **接线闭环各模块**：用 provider 构造 `LlmAnalyzer` / `LlmClarifier`；`Executor`
 *     注入内置工具；`DefaultScopeResolver({ validatePathExists: true })` / `DefaultBackupManager`
 *     / `DefaultDeliveryVerifier` / `DefaultAwarenessPresenter`。
 *  5. **装配 Orchestrator + Web 服务**：`new SseHub()` → `new Orchestrator({ ...deps,
 *     notifier: sseHub.notifier() })` → `new HttpWebServer({ orchestrator, sseHub })`。
 *  6. **导出可测装配函数 {@link buildApp}**：返回 `{ orchestrator, sseHub, webServer, ... }`，
 *     供 17.2 端到端冒烟复用（可注入 mock LLM / scanner、可在 port 0 起停或直接驱动编排器）。
 *     {@link main} 仅在作为入口**直接运行**时启动 Web 服务（绑定 `127.0.0.1`，端口取 env
 *     `PORT` 或默认 {@link DEFAULT_PORT}）。
 *
 * 安全红线：
 *  - **API key 绝不硬编码**：仅经 `validateApiKey` / `Gpt54Provider` 从环境变量读取，
 *    或由调用方显式注入（注入值同样不应来自源码明文）。
 *  - **仅绑定回环地址**：`HttpWebServer` 默认绑定 `127.0.0.1`（仅本机可达，未引入鉴权）。
 *
 * _Requirements: 6.4, 17.2, 2.3, 2.5_
 */

import { pathToFileURL, fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";

// ─── 自动加载 .env ───
const __filename_idx = fileURLToPath(import.meta.url);
const __dirname_idx = dirname(__filename_idx);
const envPathIdx = resolvePath(__dirname_idx, "../.env");
try {
  const envContent = readFileSync(envPathIdx, "utf-8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
      val = val.slice(1, -1);
    if (!process.env[key]) process.env[key] = val;
  }
} catch { /* .env 不存在则跳过 */ }

import { validateApiKey } from "./config/config.js";
import { DefaultRegistry, type Registry } from "./registry/registry.js";

import type { Device_Scanner } from "./scanner/deviceScanner.js";
import { MacScanner, ScanError } from "./scanner/macScanner.js";
import type { Scan_Summary, ScanOptions } from "./scanner/types.js";

import { Gpt54Provider } from "./llm/gpt54Provider.js";
import type { LLM_Provider } from "./llm/llmProvider.js";

import { LlmAnalyzer } from "./analyzer/analyzer.js";
import { DefaultAwarenessPresenter } from "./analyzer/presenter.js";
import { LlmClarifier } from "./clarifier/clarifier.js";
import { DefaultScopeResolver } from "./scope/scopeResolver.js";
import { DefaultBackupManager } from "./backup/backupManager.js";
import { Executor } from "./executor/executor.js";
import { BUILTIN_EXECUTOR_TOOLS, createToolRegistry } from "./executor/toolRegistry.js";
import type { Executor_Tool } from "./executor/types.js";
import { DefaultDeliveryVerifier } from "./delivery/deliveryVerifier.js";

import { Orchestrator, type OrchestratorDeps } from "./orchestrator/orchestrator.js";
import { SseHub } from "./server/sse.js";
import { DEFAULT_HOST, HttpWebServer } from "./server/webServer.js";

// ===========================================================================
// 常量
// ===========================================================================

/** Web 服务默认端口（可经环境变量 `PORT` 覆盖）。 */
export const DEFAULT_PORT = 8787;

// ===========================================================================
// UnsupportedScanner —— 非受支持平台的优雅降级扫描器（R2.5）
// ===========================================================================

/**
 * 非受支持平台（非 macOS）的占位扫描器：`isSupported()` 恒为 `false`。
 *
 * 作用：让 Orchestrator 在缺少匹配平台实现时仍能被正常装配；`Orchestrator.scan()` 会先查
 * `isSupported()`，对其返回"当前平台暂不支持扫描"的提示并停留 `idle`，**服务不崩溃**。
 * 万一被直接调用 `scan()`，亦以描述性 `ScanError` 拒绝（防御性，不会被静默执行）。
 */
export class UnsupportedScanner implements Device_Scanner {
  readonly platform: string;

  constructor(platform: string) {
    this.platform = platform;
  }

  isSupported(): boolean {
    return false;
  }

  scan(_options: ScanOptions): Promise<Scan_Summary> {
    return Promise.reject(
      new ScanError(
        `当前平台「${this.platform}」暂不支持扫描：本 demo 仅支持 macOS（darwin）。`,
      ),
    );
  }
}

// ===========================================================================
// 装配选项与产物
// ===========================================================================

/**
 * {@link buildApp} / {@link main} 的装配选项（均可选，便于测试注入 mock 与跨平台运行）。
 */
export interface BuildAppOptions {
  /** 环境变量来源，默认 `process.env`（仅在未注入 `llmProvider` 时用于读取 API key）。 */
  env?: NodeJS.ProcessEnv;
  /**
   * 显式 API key（应来自 config/环境，源码不得出现明文 key）。
   * 缺省时由 `Gpt54Provider` 经 `env` 读取（`OPENAI_API_KEY` 优先、`GPT_API_KEY` 次选）。
   */
  apiKey?: string;
  /**
   * 显式注入的 LLM 供应方（端到端冒烟用 mock）。提供时**跳过** API key 校验与
   * `Gpt54Provider` 构造，并以其 `providerKey` 注册进 `providerRegistry`。
   */
  llmProvider?: LLM_Provider;
  /** 显式注入扫描器（测试用 mock / 跨平台）。缺省时按 `platform` 从 `scannerRegistry` 解析。 */
  scanner?: Device_Scanner;
  /** 平台标识，默认 `process.platform`（用于从 `scannerRegistry` 解析对应扫描器）。 */
  platform?: string;
  /** 扫描入参，默认 `{ recentDays: 7, topN: 15, homeDir: os.homedir() }`。 */
  scanOptions?: ScanOptions;
  /** 注入时钟（ISO8601），便于测试确定性；透传给 Orchestrator。 */
  now?: () => string;
  /** 诊断/提示日志函数，默认 `console.log`（注入便于测试静默/断言）。 */
  log?: (message: string) => void;
  /** （仅 {@link main} 使用）监听端口；缺省取 env `PORT` 或 {@link DEFAULT_PORT}。 */
  port?: number;
  /** （仅 {@link main} 使用）UI 就绪握手超时（毫秒）；缺省取 `config.uiReadyTimeoutMs`。 */
  uiReadyTimeoutMs?: number;
}

/** {@link buildApp} 的装配产物：已接线但**未启动**的闭环对象集合。 */
export interface BuiltApp {
  /** 平台扫描器注册表（按平台 key）。 */
  scannerRegistry: Registry<Device_Scanner>;
  /** LLM 供应方注册表（按 provider key）。 */
  providerRegistry: Registry<LLM_Provider>;
  /** Executor 工具注册表（按 tool name）。 */
  toolRegistry: Registry<Executor_Tool>;
  /** 实际接线使用的 LLM 供应方（注入的 mock 或 `Gpt54Provider`）。 */
  llmProvider: LLM_Provider;
  /** 实际接线使用的扫描器（按平台解析所得，或非受支持平台的降级扫描器）。 */
  scanner: Device_Scanner;
  /** 闭环编排器（已注入全部依赖 + SSE notifier）。 */
  orchestrator: Orchestrator;
  /** SSE 推送通道。 */
  sseHub: SseHub;
  /** 本机 HTTP 服务（**未启动**；由 {@link main} 或调用方按需 `start`）。 */
  webServer: HttpWebServer;
}

// ===========================================================================
// buildApp —— 可测装配函数（不启动 Web 服务）
// ===========================================================================

/**
 * 装配整个闭环并返回 {@link BuiltApp}（**不启动** Web 服务，便于 17.2 端到端冒烟复用）。
 *
 * 注意：本函数假定 API key 已可用——要么注入了 `llmProvider`，要么 `apiKey`/环境变量中存在
 * 有效 key。缺失时构造 `Gpt54Provider` 会抛 `Gpt54ProviderError`；启动路径（{@link main}）
 * 已先用 `validateApiKey` 校验并优雅终止，故此处不重复处理（R6.4 的优雅终止属启动职责）。
 *
 * @throws 当未注入 `llmProvider` 且 API key 缺失时（由 `Gpt54Provider` 抛出）。
 */
export function buildApp(opts: BuildAppOptions = {}): BuiltApp {
  const log = opts.log ?? ((message: string): void => console.log(message));

  // --- 1) LLM 供应方（注入 mock 优先，否则构造 GPT-5.4；key 绝不硬编码）-----------
  const llmProvider: LLM_Provider =
    opts.llmProvider ?? new Gpt54Provider({ apiKey: opts.apiKey, env: opts.env });

  // --- 2) 三大可插拔注册表装配（R17.2/R17.3）-------------------------------------
  const scannerRegistry = new DefaultRegistry<Device_Scanner>("ScannerRegistry");
  scannerRegistry.register("darwin", new MacScanner());

  const providerRegistry = new DefaultRegistry<LLM_Provider>("ProviderRegistry");
  providerRegistry.register(llmProvider.providerKey, llmProvider);

  const tools = BUILTIN_EXECUTOR_TOOLS;
  const toolRegistry = createToolRegistry(tools);

  // --- 3) 按 process.platform 分派 Scanner（非 macOS 优雅降级，R2.3/R2.5）---------
  const platform = opts.platform ?? process.platform;
  let scanner: Device_Scanner;
  if (opts.scanner) {
    scanner = opts.scanner;
  } else if (scannerRegistry.has(platform)) {
    scanner = scannerRegistry.resolve(platform);
  } else {
    log(
      `[proactive-awareness-demo] 提示：当前平台「${platform}」暂不支持扫描` +
        `（本 demo 仅支持 macOS/darwin）。服务仍可启动，但扫描动作会返回"暂不支持"提示。`,
    );
    scanner = new UnsupportedScanner(platform);
  }

  // --- 4) 接线闭环各模块（均经 provider/接口注入）--------------------------------
  const analyzer = new LlmAnalyzer(llmProvider);
  const presenter = new DefaultAwarenessPresenter();
  const clarifier = new LlmClarifier(llmProvider);
  const scopeResolver = new DefaultScopeResolver({ validatePathExists: true });
  const backupManager = new DefaultBackupManager();
  const executor = new Executor({ llm: llmProvider, tools });
  const deliveryVerifier = new DefaultDeliveryVerifier();

  // --- 5) SSE + Orchestrator + Web 服务 -----------------------------------------
  const sseHub = new SseHub();

  const deps: OrchestratorDeps = {
    scanner,
    analyzer,
    presenter,
    clarifier,
    scopeResolver,
    backupManager,
    executor,
    deliveryVerifier,
    llmProvider,
    notifier: sseHub.notifier(),
  };
  if (opts.scanOptions) deps.scanOptions = opts.scanOptions;
  if (opts.now) deps.now = opts.now;

  const orchestrator = new Orchestrator(deps);
  const webServer = new HttpWebServer({ orchestrator, sseHub });

  return {
    scannerRegistry,
    providerRegistry,
    toolRegistry,
    llmProvider,
    scanner,
    orchestrator,
    sseHub,
    webServer,
  };
}

// ===========================================================================
// main —— 入口：校验 key → 装配 → 启动 Web 服务
// ===========================================================================

/**
 * 启动入口（仅在作为入口直接运行时调用）：
 *  1. 校验 API key（缺失则打印描述性错误并优雅终止，R6.4）。
 *  2. 装配闭环（{@link buildApp}）。
 *  3. 启动 Web 服务（绑定 `127.0.0.1`，端口取 env `PORT` 或 {@link DEFAULT_PORT}）。
 *
 * 全程不抛未捕获异常：任何失败都打印描述性错误并设置 `process.exitCode = 1` 后返回。
 */
export async function main(opts: BuildAppOptions = {}): Promise<void> {
  const log = opts.log ?? ((message: string): void => console.log(message));

  // 1) API key 启动校验（仅当未注入自定义 provider 时；R6.4 优雅终止）。
  if (!opts.llmProvider) {
    const env = opts.env ?? process.env;
    const keyCheck = validateApiKey(env);
    if (keyCheck.error) {
      console.error(`[proactive-awareness-demo] 启动中止：${keyCheck.error}`);
      process.exitCode = 1;
      return; // 优雅终止：不启动服务、不抛异常、不崩溃。
    }
    // 把已校验的 key 透传给装配（避免 Gpt54Provider 重复读取环境变量）。
    if (keyCheck.apiKey && opts.apiKey === undefined) {
      opts = { ...opts, apiKey: keyCheck.apiKey };
    }
  }

  // 2) 装配（防御性 try/catch：构造失败也优雅终止，不崩溃）。
  let app: BuiltApp;
  try {
    app = buildApp(opts);
  } catch (err) {
    console.error(`[proactive-awareness-demo] 启动失败：${describeError(err)}`);
    process.exitCode = 1;
    return;
  }

  // 3) 启动 Web 服务（仅绑定回环地址）。
  const port = resolvePort(opts.port ?? process.env.PORT);
  try {
    const startOpts: { port: number; host: string; uiReadyTimeoutMs?: number } = {
      port,
      host: DEFAULT_HOST,
    };
    if (opts.uiReadyTimeoutMs !== undefined) {
      startOpts.uiReadyTimeoutMs = opts.uiReadyTimeoutMs;
    }
    await app.webServer.start(startOpts);
  } catch (err) {
    console.error(`[proactive-awareness-demo] Web 服务启动失败：${describeError(err)}`);
    process.exitCode = 1;
    return;
  }

  const shownPort = app.webServer.address()?.port ?? port;
  log(
    `[proactive-awareness-demo] 已就绪：请用浏览器打开 http://${DEFAULT_HOST}:${shownPort} ` +
      `（仅本机可达；UI 未在就绪超时内连接将自动关闭服务）。`,
  );
}

// ===========================================================================
// 内部辅助
// ===========================================================================

/** 解析监听端口：合法整数（0-65535）原样采用，否则回退 {@link DEFAULT_PORT}。 */
export function resolvePort(raw: string | number | undefined): number {
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw <= 65535) {
    return raw;
  }
  if (typeof raw === "string" && raw.trim().length > 0) {
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 0 && n <= 65535) return n;
  }
  return DEFAULT_PORT;
}

/** 把未知错误对象转为可读字符串（用于描述性错误信息）。 */
function describeError(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  try {
    return JSON.stringify(cause);
  } catch {
    return String(cause);
  }
}

// ===========================================================================
// 入口判定：仅在作为入口直接运行时启动服务（被 import 时不自动启动，便于测试复用）
// ===========================================================================

/** 当前模块是否作为入口被直接运行（`node dist/index.js` / `tsx src/index.ts`）。 */
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  void main();
}
