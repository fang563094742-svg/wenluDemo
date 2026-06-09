/**
 * 任务 17.3：装配 / 红线 smoke 测试（vitest，非 property）。
 *
 * 被测：
 *  - `src/index.ts` 的 `buildApp`——三大可插拔注册表（scanner / provider / tool）已正确装配。
 *  - `src/server/webServer.ts`——本机服务仅绑定回环地址 `127.0.0.1`（安全红线）。
 *  - `src/orchestrator/session.ts`——`getSession` 单例（R18.3 单用户）。
 *  - 源码全局红线（静态扫描 `src/**\/*.ts`）：
 *      · 无硬编码 API key（无 `sk-` 明文、无 apiKey 字面量赋值）（R6.3）；
 *      · 无问路系统 import（不从工作区其他目录 / src 之外相对·绝对 import）（R17.4）；
 *      · 无 android / iPad 扫描实现、无 iOS App 集成（R18.1 / R18.2）；
 *
 * 设计依据：design.md「Architecture → 分层与可插拔点」「0. 可插拔注册表」「7. Web 服务」
 * 与「安全要点 → 本地服务安全提示」；requirements R6.3 / R16.1 / R17.4 / R18.1 / R18.2 / R18.3。
 *
 * 安全：webServer 监听测试用 `port: 0`（系统分配空闲端口）+ 注入 fake `exit`（不真正杀进程），
 * 关闭自毁计时器（`uiReadyTimeoutMs: 0`），用完即 `shutdown`，不残留监听。
 *
 * _Requirements: 6.3, 16.1, 17.4, 18.1, 18.2, 18.3_
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";

import { buildApp } from "../../src/index.js";
import {
  HttpWebServer,
  DEFAULT_HOST,
  LOOPBACK_HOSTS,
} from "../../src/server/webServer.js";
import { SseHub } from "../../src/server/sse.js";
import { getSession, resetSession } from "../../src/orchestrator/session.js";
import type {
  LLM_Provider,
  LlmRequest,
  LlmResponse,
  LlmToolRequest,
  LlmToolResponse,
} from "../../src/llm/llmProvider.js";

// ---------------------------------------------------------------------------
// 测试替身：mock LLM_Provider（注入后 buildApp 跳过 API key 校验 / Gpt54Provider 构造）
// ---------------------------------------------------------------------------

/** 最小 mock 供应方：仅满足接口契约，本 smoke 测试不真正调用其方法。 */
class MockLlmProvider implements LLM_Provider {
  readonly providerKey = "mock-llm";
  complete(_req: LlmRequest): Promise<LlmResponse> {
    return Promise.resolve({ text: "{}" });
  }
  completeWithTools(_req: LlmToolRequest): Promise<LlmToolResponse> {
    return Promise.resolve({ finalText: "" });
  }
}

// ---------------------------------------------------------------------------
// 源码静态扫描辅助
// ---------------------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 被扫描的源码根目录：<repoRoot>/src。 */
const SRC_ROOT = path.resolve(HERE, "../../src");

/** 递归收集某目录下全部 `.ts` 文件的绝对路径。 */
function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

/** 抽取一个源码文件里的全部 import / export-from / dynamic import 的模块标识符。 */
function importSpecifiers(content: string): string[] {
  const specs: string[] = [];
  // 匹配 `from "x"` / `import "x"` / `import("x")`（含 export ... from）。
  const re = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    if (m[1]) specs.push(m[1]);
  }
  return specs;
}

const SRC_FILES = listTsFiles(SRC_ROOT);

// ===========================================================================
// 1) 三大可插拔注册表可注册-解析（R17.2 / R17.3）
// ===========================================================================

describe("装配：三大可插拔注册表（R17.2/R17.3）", () => {
  it("buildApp 装配后 scanner / provider / tool 三大注册表均可注册-解析", () => {
    const provider = new MockLlmProvider();
    // 注入 mock provider + 显式 platform=darwin，使装配在任意 CI 平台上确定可复现。
    const app = buildApp({ llmProvider: provider, platform: "darwin", log: () => {} });

    // scannerRegistry：按平台 key 注册了 macOS 实现。
    expect(app.scannerRegistry.has("darwin")).toBe(true);
    expect(app.scannerRegistry.resolve("darwin").platform).toBe("darwin");

    // providerRegistry：按 provider key 注册了所用供应方。
    expect(app.providerRegistry.has(provider.providerKey)).toBe(true);
    expect(app.providerRegistry.resolve(provider.providerKey)).toBe(provider);

    // toolRegistry：五个内置工具均可按 tool name 解析。
    const expectedTools = [
      "read_file",
      "write_file",
      "list_dir",
      "run_command",
      "delete_file",
    ];
    for (const name of expectedTools) {
      expect(app.toolRegistry.has(name)).toBe(true);
      expect(app.toolRegistry.resolve(name).name).toBe(name);
    }

    // 实际接线使用的 provider / scanner 即上面注册的实现。
    expect(app.llmProvider).toBe(provider);
    expect(app.scanner.platform).toBe("darwin");
  });

  it("解析未注册 key 抛描述性错误（不静默返回 undefined）", () => {
    const app = buildApp({ llmProvider: new MockLlmProvider(), platform: "darwin", log: () => {} });
    expect(() => app.toolRegistry.resolve("no_such_tool")).toThrow(/no_such_tool/);
  });
});

// ===========================================================================
// 2) 本机服务仅绑定回环地址 127.0.0.1（安全红线 R16.1）
// ===========================================================================

describe("安全红线：Web 服务仅绑定 127.0.0.1（R16.1）", () => {
  it("默认 host 常量为 127.0.0.1（webServer 安全红线）", () => {
    expect(DEFAULT_HOST).toBe("127.0.0.1");
    expect(LOOPBACK_HOSTS.has("0.0.0.0")).toBe(false);
  });

  it("start(port:0) 后实际监听地址为 127.0.0.1，用完 shutdown（注入 fake exit 不杀进程）", async () => {
    const app = buildApp({ llmProvider: new MockLlmProvider(), platform: "darwin", log: () => {} });

    // 独立构造一个注入了 fake exit 的 webServer（buildApp 内置 webServer 用真实 process.exit，
    // 直接 shutdown 会杀测试进程）。复用 app.orchestrator（结构兼容 OrchestratorActions）。
    const exitCalls: number[] = [];
    const fakeExit = ((code: number): never => {
      exitCalls.push(code);
      return undefined as never;
    }) as (code: number) => never;

    const server = new HttpWebServer({
      orchestrator: app.orchestrator,
      sseHub: new SseHub({ heartbeatMs: 0 }),
      exit: fakeExit,
      log: () => {},
    });

    // uiReadyTimeoutMs: 0 关闭自毁计时器，避免异步自毁触发 exit。
    await server.start({ port: 0, uiReadyTimeoutMs: 0 });
    try {
      const addr = server.address() as AddressInfo;
      expect(addr).not.toBeNull();
      expect(addr.address).toBe("127.0.0.1");
    } finally {
      await server.shutdown("test cleanup", 0);
    }

    // shutdown 调用了注入的 fake exit（未触达真实 process.exit）。
    expect(exitCalls).toContain(0);
    expect(server.address()).toBeNull();
  });
});

// ===========================================================================
// 3) 源码无硬编码 API key（R6.3）
// ===========================================================================

describe("安全红线：源码无硬编码 API key（R6.3）", () => {
  it("src/**/*.ts 中无 sk- 形式的明文密钥", () => {
    // OpenAI 风格密钥：sk- 后跟一长串字母数字（含 sk-proj- 等变体）。
    const skLike = /\bsk-[A-Za-z0-9_-]{16,}\b/;
    const offenders: string[] = [];
    for (const file of SRC_FILES) {
      const content = fs.readFileSync(file, "utf8");
      if (skLike.test(content)) {
        offenders.push(path.relative(SRC_ROOT, file));
      }
    }
    expect(offenders, `疑似硬编码密钥的文件: ${offenders.join(", ")}`).toEqual([]);
  });

  it("src/**/*.ts 中无形如 apiKey = \"<明文>\" 的密钥字面量赋值", () => {
    // 命中 `apiKey: "长串"` / `api_key = '长串'` 之类的明文赋值（≥16 字符）。
    const keyLiteral = /(api[_-]?key)\s*[:=]\s*["'][^"']{16,}["']/i;
    const offenders: string[] = [];
    for (const file of SRC_FILES) {
      const content = fs.readFileSync(file, "utf8");
      if (keyLiteral.test(content)) {
        offenders.push(path.relative(SRC_ROOT, file));
      }
    }
    expect(offenders, `疑似 key 字面量赋值的文件: ${offenders.join(", ")}`).toEqual([]);
  });
});

// ===========================================================================
// 4) 无问路系统 import（与现有问路系统零代码耦合，R17.4）
// ===========================================================================

describe("红线：源码无问路系统 import（R17.4 零耦合）", () => {
  it("src 内所有相对 / 绝对 import 均落在 src 目录之内（不引用工作区其他目录）", () => {
    const escaping: { file: string; spec: string }[] = [];
    for (const file of SRC_FILES) {
      const content = fs.readFileSync(file, "utf8");
      for (const spec of importSpecifiers(content)) {
        // node 内置模块放行。
        if (spec.startsWith("node:")) continue;
        // 裸包名（npm 依赖）放行——当前工程 dependencies 为空，若出现也非工作区耦合。
        if (!spec.startsWith(".") && !spec.startsWith("/")) continue;

        // 相对 / 绝对路径：词法解析后必须仍在 SRC_ROOT 内。
        const resolved = spec.startsWith("/")
          ? path.resolve(spec)
          : path.resolve(path.dirname(file), spec);
        const inSrc = resolved === SRC_ROOT || resolved.startsWith(SRC_ROOT + path.sep);
        if (!inSrc) {
          escaping.push({ file: path.relative(SRC_ROOT, file), spec });
        }
      }
    }
    expect(
      escaping,
      `逃逸 src 的 import: ${escaping.map((e) => `${e.file} → ${e.spec}`).join("; ")}`,
    ).toEqual([]);
  });

  it("src 内无 import 引用工作区兄弟目录标记（如 3.1后端 / mac-native / 问路）", () => {
    const markers = ["3.1后端", "mac-native", "问路", "wenlu-3."];
    const offenders: { file: string; spec: string }[] = [];
    for (const file of SRC_FILES) {
      const content = fs.readFileSync(file, "utf8");
      for (const spec of importSpecifiers(content)) {
        if (markers.some((mk) => spec.includes(mk))) {
          offenders.push({ file: path.relative(SRC_ROOT, file), spec });
        }
      }
    }
    expect(
      offenders,
      `引用工作区其他系统的 import: ${offenders.map((e) => `${e.file} → ${e.spec}`).join("; ")}`,
    ).toEqual([]);
  });
});

// ===========================================================================
// 5) 无 android / iPad 扫描实现、无 iOS App 集成（R18.1 / R18.2）
// ===========================================================================

describe("范围红线：无 android/iPad 扫描实现、无 iOS App 集成（R18.1/R18.2）", () => {
  it("src 内无 android / ipad / ios 命名的扫描器实现文件", () => {
    // 仅保留 Device_Scanner 接口预留，第一版不提供这些平台的扫描实现文件。
    const forbidden = /(android|ipad|ios)/i;
    const offenders = SRC_FILES
      .map((f) => path.relative(SRC_ROOT, f))
      .filter((rel) => forbidden.test(path.basename(rel)));
    expect(offenders, `疑似 android/ipad/ios 实现文件: ${offenders.join(", ")}`).toEqual([]);
  });

  it("实现 Device_Scanner 的类仅有 MacScanner 与 UnsupportedScanner（无安卓/iOS 实现）", () => {
    const implRe = /export\s+class\s+(\w+)\s+implements\s+Device_Scanner/g;
    const implementors: string[] = [];
    for (const file of SRC_FILES) {
      const content = fs.readFileSync(file, "utf8");
      let m: RegExpExecArray | null;
      while ((m = implRe.exec(content)) !== null) {
        if (m[1]) implementors.push(m[1]);
      }
    }
    expect(implementors.sort()).toEqual(["MacScanner", "UnsupportedScanner"]);
  });
});

// ===========================================================================
// 6) Session 单例（R18.3 单用户）
// ===========================================================================

describe("Session 单例（R18.3 单用户）", () => {
  it("getSession 多次调用返回同一引用", () => {
    const a = getSession();
    const b = getSession();
    expect(a).toBe(b);
  });

  it("resetSession 产出新引用后，后续 getSession 稳定返回该新引用", () => {
    const before = getSession();
    const fresh = resetSession();
    expect(fresh).not.toBe(before);
    expect(getSession()).toBe(fresh);
    expect(getSession()).toBe(getSession());
  });
});
