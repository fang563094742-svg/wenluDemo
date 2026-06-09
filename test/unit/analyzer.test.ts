/**
 * 任务 6.5：Analyzer prompt 构造/解析与 LLM 失败分支单元测试（vitest，非 property）。
 *
 * 覆盖（mock LLM，不接真实供应方）：
 *  - 动态走 LLM：`LlmAnalyzer.analyze` 调用 `provider.complete`，且传给 LLM 的请求带
 *    schema 约束与「证据引用 + 三段式主动推断」prompt 设计方向（R5.1）。
 *  - 输出解析容错：纯 JSON / 剥离 ```json 围栏 / 从夹杂文字中截取首尾大括号 三种形态均能解析。
 *  - LLM 失败分支：`provider.complete` 抛错或返回不可解析文本时，`analyze` 抛
 *    `AnalyzerError`（描述性、非致命），而非让进程崩溃——服务可继续运行（R5.5/R5.6）。
 *
 * _Requirements: 5.1, 5.5_
 */

import { describe, it, expect, vi } from "vitest";

import {
  LlmAnalyzer,
  AnalyzerError,
  buildSystemPrompt,
  buildUserPrompt,
  parseAnalyzerJson,
  ANALYZER_OUTPUT_SCHEMA,
  deriveTitleFromRationale,
  DERIVED_TITLE_MAX_LEN,
} from "../../src/analyzer/analyzer.js";
import type {
  LLM_Provider,
  LlmRequest,
  LlmResponse,
  LlmToolRequest,
  LlmToolResponse,
} from "../../src/llm/llmProvider.js";
import type { Scan_Summary } from "../../src/scanner/types.js";

// ---------------------------------------------------------------------------
// 测试夹具：最小 Scan_Summary 与可控 mock LLM_Provider
// ---------------------------------------------------------------------------

/** 构造一个含文件/git/app 三类条目的最小 Scan_Summary。 */
function makeSummary(): Scan_Summary {
  return {
    scannedAt: "2026-01-01T00:00:00.000Z",
    platform: "darwin",
    recentDays: 7,
    items: [
      {
        kind: "file",
        score: 0.9,
        file: {
          name: "report.md",
          path: "/Users/demo/work/report.md",
          mtime: "2025-12-31T10:00:00.000Z",
          sizeBytes: 1024,
          ext: ".md",
        },
      },
      {
        kind: "git",
        score: 0.8,
        git: {
          repoPath: "/Users/demo/work/repo",
          recentCommits: [
            { hash: "abc123", message: "wip: 草拟年终报告", date: "2025-12-31T09:00:00.000Z" },
          ],
          changedFiles: ["/Users/demo/work/repo/report.md"],
          currentBranch: "main",
        },
      },
      {
        kind: "app",
        score: 0.7,
        app: { appName: "Visual Studio Code", bundleId: "com.microsoft.VSCode" },
      },
    ],
  };
}

/**
 * 可控 mock LLM_Provider：
 *  - 若提供 `responder` 抛出，则模拟调用失败（complete reject）。
 *  - 否则返回 `responder(req)` 给出的文本。
 * 记录最后一次收到的请求供断言。
 */
function makeMockProvider(
  responder: (req: LlmRequest) => string,
): { provider: LLM_Provider; complete: ReturnType<typeof vi.fn> } {
  const complete = vi.fn(async (req: LlmRequest): Promise<LlmResponse> => {
    const text = responder(req); // 若 responder 内部 throw，则模拟供应方调用失败
    return { text };
  });

  const provider: LLM_Provider = {
    providerKey: "mock",
    complete,
    completeWithTools: async (_req: LlmToolRequest): Promise<LlmToolResponse> => {
      throw new Error("not used in analyzer tests");
    },
  };
  return { provider, complete };
}

/** 固定 id 工厂，便于断言确定性输出。 */
function seqIdFactory(): () => string {
  let n = 0;
  return () => `id-${++n}`;
}

// 一份合法的、含证据的察觉项 JSON（被多个解析用例复用）。
const VALID_ITEMS_OBJECT = {
  items: [
    {
      title: "完善年终报告",
      rationale:
        "我检测到你最近在改 report.md，并有提交「wip: 草拟年终报告」；我猜你可能想把报告定稿；需要我帮你补全结构吗？",
      evidence: ["/Users/demo/work/report.md", "commit abc123: wip: 草拟年终报告"],
    },
  ],
};
const VALID_ITEMS_JSON = JSON.stringify(VALID_ITEMS_OBJECT);

// ===========================================================================
// 1) Prompt 构造方向（R5.1）
// ===========================================================================

describe("Analyzer prompt 构造（R5.1）", () => {
  it("system prompt 体现「察觉—推断—邀约」三段式与证据引用强制约束", () => {
    const sys = buildSystemPrompt();
    // 三段式三个动作均出现
    expect(sys).toContain("察觉");
    expect(sys).toContain("推断");
    expect(sys).toContain("邀约");
    // 证据引用要求与「至多 3 条」约束
    expect(sys).toContain("证据");
    expect(sys).toContain("3");
    // 反对泛泛之谈的方向性约束
    expect(sys).toContain("Scan_Summary");
  });

  it("user prompt 注入 Scan_Summary 的真实条目（文件名/提交信息/App 名可回溯）", () => {
    const summary = makeSummary();
    const user = buildUserPrompt(summary);
    expect(user).toContain("report.md");
    expect(user).toContain("草拟年终报告");
    expect(user).toContain("Visual Studio Code");
  });
});

// ===========================================================================
// 2) 动态走 LLM：complete 被调用且请求带 schema 与 prompt 约束（R5.1）
// ===========================================================================

describe("LlmAnalyzer.analyze 动态走 LLM（R5.1）", () => {
  it("调用 provider.complete，且请求携带 system/user prompt 与输出 schema 约束", async () => {
    const { provider, complete } = makeMockProvider(() => VALID_ITEMS_JSON);
    const analyzer = new LlmAnalyzer(provider, seqIdFactory());
    const summary = makeSummary();

    const items = await analyzer.analyze(summary);

    // complete 恰被调用一次（动态推断而非固定模板/常量返回）
    expect(complete).toHaveBeenCalledTimes(1);

    const req = complete.mock.calls[0]![0] as LlmRequest;
    // 请求带 schema 约束（至多 3 条、每条非空 evidence 的方向）
    expect(req.jsonSchema).toBe(ANALYZER_OUTPUT_SCHEMA);
    // system 段是证据/三段式约束 prompt
    expect(req.system).toBe(buildSystemPrompt());
    // user 段注入了真实扫描条目，且 evidence 约束方向可回溯
    expect(req.messages[0]!.role).toBe("user");
    expect(req.messages[0]!.content).toContain("report.md");

    // 解析出的察觉带非空 evidence
    expect(items).toHaveLength(1);
    expect(items[0]!.evidence.length).toBeGreaterThan(0);
    expect(items[0]!.id).toBe("id-1");
  });

  it("输出超过 3 条时截断为至多 3 条，且剔除空 evidence 条目", async () => {
    const many = {
      items: [
        { title: "a", rationale: "r1", evidence: ["e1"] },
        { title: "b", rationale: "r2", evidence: ["e2"] },
        { title: "c", rationale: "r3", evidence: ["e3"] },
        { title: "d", rationale: "r4", evidence: ["e4"] },
        // 空 evidence 应被剔除
        { title: "e", rationale: "r5", evidence: [] },
      ],
    };
    const { provider } = makeMockProvider(() => JSON.stringify(many));
    const analyzer = new LlmAnalyzer(provider, seqIdFactory());

    const items = await analyzer.analyze(makeSummary());
    expect(items).toHaveLength(3);
    for (const it of items) {
      expect(it.evidence.length).toBeGreaterThan(0);
    }
  });
});

// ===========================================================================
// 3) 输出解析容错（纯 JSON / ```json 围栏 / 截取大括号）
// ===========================================================================

describe("parseAnalyzerJson 输出解析容错", () => {
  it("解析纯 JSON 文本", () => {
    const parsed = parseAnalyzerJson(VALID_ITEMS_JSON);
    expect(Array.isArray(parsed.items)).toBe(true);
  });

  it("剥离 ```json 代码块围栏后解析", () => {
    const fenced = "```json\n" + VALID_ITEMS_JSON + "\n```";
    const parsed = parseAnalyzerJson(fenced);
    expect(Array.isArray(parsed.items)).toBe(true);
    expect((parsed.items as unknown[]).length).toBe(1);
  });

  it("从夹杂自然语言文字中截取首尾大括号块后解析", () => {
    const messy =
      "好的，这是我的分析结果：\n" + VALID_ITEMS_JSON + "\n以上就是全部内容，谢谢。";
    const parsed = parseAnalyzerJson(messy);
    expect(Array.isArray(parsed.items)).toBe(true);
  });

  it("LlmAnalyzer 能消化带 ```json 围栏的 LLM 输出并产出察觉项", async () => {
    const fenced = "```json\n" + VALID_ITEMS_JSON + "\n```";
    const { provider } = makeMockProvider(() => fenced);
    const analyzer = new LlmAnalyzer(provider, seqIdFactory());

    const items = await analyzer.analyze(makeSummary());
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toBe("完善年终报告");
  });
});

// ===========================================================================
// 4) LLM 失败分支：抛 AnalyzerError 而非崩溃（服务保持运行，R5.5/R5.6）
// ===========================================================================

describe("LlmAnalyzer.analyze 失败分支保持服务运行（R5.5）", () => {
  it("provider.complete 抛错时，包装为 AnalyzerError 抛出（不让进程崩溃）", async () => {
    const { provider, complete } = makeMockProvider(() => {
      throw new Error("network down: ECONNREFUSED");
    });
    const analyzer = new LlmAnalyzer(provider, seqIdFactory());

    await expect(analyzer.analyze(makeSummary())).rejects.toBeInstanceOf(AnalyzerError);
    expect(complete).toHaveBeenCalledTimes(1);

    // 描述性错误信息且保留原因链
    await expect(analyzer.analyze(makeSummary())).rejects.toMatchObject({
      name: "AnalyzerError",
    });
  });

  it("LLM 返回不可解析文本时，抛 AnalyzerError（解析失败也非致命）", async () => {
    const { provider } = makeMockProvider(() => "我无法给出 JSON，这是一段没有大括号的纯文字");
    const analyzer = new LlmAnalyzer(provider, seqIdFactory());

    await expect(analyzer.analyze(makeSummary())).rejects.toBeInstanceOf(AnalyzerError);
  });

  it("失败后再次正常调用仍可成功（服务保持可继续运行，非一次失败即崩溃）", async () => {
    // 第一次抛错，第二次返回合法 JSON：用调用计数切换行为
    let calls = 0;
    const { provider } = makeMockProvider(() => {
      calls += 1;
      if (calls === 1) throw new Error("transient failure");
      return VALID_ITEMS_JSON;
    });
    const analyzer = new LlmAnalyzer(provider, seqIdFactory());

    await expect(analyzer.analyze(makeSummary())).rejects.toBeInstanceOf(AnalyzerError);
    const items = await analyzer.analyze(makeSummary());
    expect(items).toHaveLength(1);
  });

  it("parseAnalyzerJson 对不可解析文本直接抛 AnalyzerError", () => {
    expect(() => parseAnalyzerJson("not json at all")).toThrow(AnalyzerError);
  });
});

// ===========================================================================
// 5) 解析兜底：模型漏给 title 时从 rationale 派生（健壮性，R5.2/R5.3 仍成立）
// ===========================================================================

describe("LlmAnalyzer 解析兜底：title 缺失/空时从 rationale 派生（健壮性）", () => {
  it("真实场景：模型把全部内容塞进 rationale、不给 title → 不丢弃，自动派生 title", async () => {
    // 复刻实测：3 条察觉每条都缺 title、只有 rationale + evidence。
    const payload = {
      items: [
        {
          rationale:
            "察觉：我检测到你最近在改 report.md；推断：我猜你想把年终报告定稿；邀约：需要我帮你补全结构吗？",
          evidence: ["/Users/demo/work/report.md"],
        },
        {
          rationale: "你最近频繁切换到 Visual Studio Code 编辑代码，可能在赶一个功能。",
          evidence: ["Visual Studio Code"],
        },
        {
          rationale: "仓库 repo 有未推送提交 abc123，可能需要整理并推送。",
          evidence: ["commit abc123"],
        },
      ],
    };
    const { provider } = makeMockProvider(() => JSON.stringify(payload));
    const analyzer = new LlmAnalyzer(provider, seqIdFactory());

    const items = await analyzer.analyze(makeSummary());

    // 闭环不再断在第一步：3 条全部保留（而非 0 条）。
    expect(items).toHaveLength(3);
    for (const it of items) {
      // 每条都有非空 title（派生而来）与非空 evidence（硬要求）。
      expect(it.title.trim().length).toBeGreaterThan(0);
      expect(it.evidence.length).toBeGreaterThan(0);
    }
    // 第一条剥离了「察觉：」前缀并取首句。
    expect(items[0]!.title).toBe("我检测到你最近在改 report.md");
  });

  it("title 缺失但 evidence 为空 → 仍丢弃（evidence 非空是不兜底的硬要求）", async () => {
    const payload = {
      items: [{ rationale: "有理由但没证据", evidence: [] }],
    };
    const { provider } = makeMockProvider(() => JSON.stringify(payload));
    const analyzer = new LlmAnalyzer(provider, seqIdFactory());

    const items = await analyzer.analyze(makeSummary());
    expect(items).toHaveLength(0);
  });

  it("title 与 rationale 同时为空 → 丢弃（无任何可呈现信息）", async () => {
    const payload = {
      items: [{ title: "  ", rationale: "", evidence: ["e1"] }],
    };
    const { provider } = makeMockProvider(() => JSON.stringify(payload));
    const analyzer = new LlmAnalyzer(provider, seqIdFactory());

    const items = await analyzer.analyze(makeSummary());
    expect(items).toHaveLength(0);
  });

  it("显式 title 存在时优先用 title，不触发派生", async () => {
    const payload = {
      items: [{ title: "明确标题", rationale: "察觉：很长的一段推断理由……", evidence: ["e1"] }],
    };
    const { provider } = makeMockProvider(() => JSON.stringify(payload));
    const analyzer = new LlmAnalyzer(provider, seqIdFactory());

    const items = await analyzer.analyze(makeSummary());
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toBe("明确标题");
  });
});

describe("deriveTitleFromRationale 派生规则", () => {
  it("剥离三段式前缀并取首句", () => {
    expect(deriveTitleFromRationale("察觉：我在改 report.md。推断：想定稿。")).toBe(
      "我在改 report.md",
    );
  });

  it("超长 rationale 截断到上限并补省略号", () => {
    const long = "a".repeat(100);
    const title = deriveTitleFromRationale(long);
    expect(title.length).toBeLessThanOrEqual(DERIVED_TITLE_MAX_LEN + 1); // +1 为省略号
    expect(title.endsWith("…")).toBe(true);
  });

  it("无前缀、单句直接返回（trim）", () => {
    expect(deriveTitleFromRationale("  整理下载目录  ")).toBe("整理下载目录");
  });
});
