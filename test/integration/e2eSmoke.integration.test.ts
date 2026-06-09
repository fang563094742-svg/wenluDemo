/**
 * 任务 17.2：端到端冒烟测试（mock LLM 跑通闭环）。
 *
 * 被测：`src/index.ts` 的 `buildApp`——注入 mock `LLM_Provider` + mock `Device_Scanner` +
 * 真实其余模块（analyzer / clarifier / scope / backup / executor / delivery / orchestrator），
 * 装配出完整闭环编排器，驱动其走完「链路 A：主动察觉」全闭环：
 *
 *   scan → analyze →（accept）clarify →（answer 至 sufficient）→ confirm-understanding →
 *   confirm-scope（指向临时 sandbox）→ start-execution → backup → execute（真实 write_file 落地）→
 *   verify → delivery-report → accept-delivery
 *
 * 这是验证整个闭环串联的唯一自动化测试（必做）。
 *
 * 断言：
 *  1. 最终会话状态为 `accepted`（用户"确认完成"验收，R15.5）。
 *  2. 执行**真实落地了文件**——临时 sandbox 内 `output.txt` 确被创建且内容正确（R12.1/R12.5）。
 *  3. 验收报告（Delivery_Report）**含证据**——逐条 Acceptance_Test 结果（全部通过）+ 改动文件
 *     diff（R15.2），且 `hasFailures === false`。
 *
 * 安全边界：所有真实落地操作均发生在 `os.tmpdir()` 下的临时 sandbox 目录内，测试结束清理；
 * 绝不触及项目目录外的用户真实路径。mock LLM 不发起任何网络请求。
 *
 * mock LLM 策略：`complete` 按 **jsonSchema 引用** 精确分派（analyzer / clarifier begin /
 * clarifier next / clarifier sufficient 各自传入其导出的 schema 常量），`completeWithTools`
 * 按固定脚本（write_file → finalText）驱动 Executor 真实落地。
 *
 * _Requirements: 12.1, 16.1_
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildApp } from "../../src/index.js";
import { SessionState } from "../../src/orchestrator/session.js";
import { ANALYZER_OUTPUT_SCHEMA } from "../../src/analyzer/analyzer.js";
import {
  BEGIN_OUTPUT_SCHEMA,
  NEXT_OUTPUT_SCHEMA,
  SUFFICIENT_OUTPUT_SCHEMA,
} from "../../src/clarifier/clarifier.js";

import type { Device_Scanner } from "../../src/scanner/deviceScanner.js";
import type {
  Scan_Summary,
  ScanOptions,
  ScanProgressEvent,
} from "../../src/scanner/types.js";
import type {
  LLM_Provider,
  LlmRequest,
  LlmResponse,
  LlmToolRequest,
  LlmToolResponse,
} from "../../src/llm/llmProvider.js";
import type { UserAnswer } from "../../src/clarifier/types.js";

// ===========================================================================
// 测试锚点：待落地文件与内容（作为"真实落地"的断言基准）
// ===========================================================================

/** 执行阶段真实写入的文件（相对 sandbox 根）；同时作为 primaryTargets。 */
const TARGET_REL = "output.txt";
/** 写入内容（含验收测试断言的子串 "hello wenlu"）。 */
const FILE_CONTENT = "hello wenlu — 端到端闭环真实落地 0xC0DE";
/** 验收测试断言文件包含的子串。 */
const ACCEPTANCE_NEEDLE = "hello wenlu";

// ===========================================================================
// mock LLM_Provider —— 按 jsonSchema 引用精确分派 + tool-calling 固定脚本
// ===========================================================================

/**
 * 受控 mock LLM：
 *  - `complete`：按 `req.jsonSchema` 的**引用相等**分派到 analyzer / clarifier 各阶段的
 *    受控 JSON 输出。clarifier `next` 第一轮产出一个低风险模糊前提（触发提问），第二轮
 *    将其判为 `known`（触发充分性，组装 Task_Frame）。
 *  - `completeWithTools`：固定脚本 write_file → finalText，驱动 Executor 真实落地。
 */
class MockLlmProvider implements LLM_Provider {
  readonly providerKey = "mock-e2e";

  /** clarifier `next` 调用计数（区分第一轮提问 vs 第二轮充分）。 */
  private nextCalls = 0;
  /** executor `completeWithTools` 调用计数（区分先写文件、后声称完成）。 */
  private toolCalls = 0;

  /** 记录各阶段被调用次数，供测试断言闭环确实流经各模块。 */
  readonly stats = { analyze: 0, begin: 0, next: 0, sufficient: 0, tool: 0 };

  complete(req: LlmRequest): Promise<LlmResponse> {
    if (req.jsonSchema === ANALYZER_OUTPUT_SCHEMA) {
      this.stats.analyze += 1;
      return this.json({
        items: [
          {
            title: `在工作目录创建 ${TARGET_REL}`,
            rationale:
              `我检测到你最近在编辑 ~/projects/demo/${TARGET_REL}（最近修改）；` +
              "我猜你可能需要快速生成一个文本文件；需要我帮你创建并写入内容吗？",
            evidence: [`最近修改的文件：~/projects/demo/${TARGET_REL}`],
          },
        ],
      });
    }

    if (req.jsonSchema === BEGIN_OUTPUT_SCHEMA) {
      this.stats.begin += 1;
      // 单一粗粒度阶段：使澄清在一两轮内收敛（无 advance_phase 分支）。
      return this.json({
        phases: [{ title: "实现改动", order: 1 }],
        convergenceSuggested: false,
      });
    }

    if (req.jsonSchema === NEXT_OUTPUT_SCHEMA) {
      this.stats.next += 1;
      this.nextCalls += 1;
      const status = this.nextCalls === 1 ? "ambiguous" : "known";
      const questions =
        this.nextCalls === 1
          ? [
              {
                text: `你希望写入 ${TARGET_REL} 的内容是什么？`,
                targetPreconditionIndexes: [1],
              },
            ]
          : [];
      return this.json({
        preconditions: [
          {
            description: `目标文件 ${TARGET_REL} 的内容`,
            status,
            // 低风险、非高危动作（避免命中规则强制高危：删除/权限/sudo/不可逆等）。
            risk_level: "low",
            related_action: `在工作目录新建文本文件 ${TARGET_REL} 并填入内容`,
          },
        ],
        phaseSaturated: this.nextCalls > 1,
        questions,
      });
    }

    if (req.jsonSchema === SUFFICIENT_OUTPUT_SCHEMA) {
      this.stats.sufficient += 1;
      return this.json({
        objective: `在工作目录创建 ${TARGET_REL} 并写入约定内容`,
        acceptanceTests: [
          {
            description: `${TARGET_REL} 存在且包含约定内容`,
            // 文件内容断言（file: 前缀）：可由 Delivery_Verifier 在 sandbox 内自动检验。
            checkMethod: `file:${TARGET_REL} contains ${ACCEPTANCE_NEEDLE}`,
          },
        ],
        primaryTargets: [TARGET_REL],
      });
    }

    return Promise.reject(
      new Error(
        `mock complete：未识别的 jsonSchema（测试未覆盖的 LLM 调用阶段）。`,
      ),
    );
  }

  completeWithTools(_req: LlmToolRequest): Promise<LlmToolResponse> {
    this.stats.tool += 1;
    this.toolCalls += 1;
    if (this.toolCalls === 1) {
      // 第一步：真实写入目标文件（落地动作，触及 primaryTargets）。
      return Promise.resolve({
        toolCalls: [
          {
            id: "tc-write",
            name: "write_file",
            arguments: { path: TARGET_REL, content: FILE_CONTENT },
          },
        ],
      });
    }
    // 第二步：声称完成（hasMaterializedRelevantActions 将校验确有相关落地动作）。
    return Promise.resolve({
      finalText: `已在工作目录创建并写入 ${TARGET_REL}，任务完成。`,
    });
  }

  /** 把对象序列化为 LlmResponse.text（mock 输出即合法 JSON 字符串）。 */
  private json(payload: unknown): Promise<LlmResponse> {
    return Promise.resolve({ text: JSON.stringify(payload) });
  }
}

// ===========================================================================
// mock Device_Scanner —— 返回受控 Scan_Summary（不触碰真实文件系统）
// ===========================================================================

/** 受控扫描器：受支持平台，扫描即推送一条具身化线索并返回固定 Scan_Summary。 */
class MockScanner implements Device_Scanner {
  readonly platform = "darwin";

  isSupported(): boolean {
    return true;
  }

  scan(
    options: ScanOptions,
    onProgress?: (event: ScanProgressEvent) => void,
  ): Promise<Scan_Summary> {
    // 扫描具身化：推送一条仅含元信息级线索的进度（绝不含正文）。
    onProgress?.({ type: "scan:progress", found: [`${TARGET_REL}（最近修改）`] });
    return Promise.resolve({
      scannedAt: new Date().toISOString(),
      platform: this.platform,
      recentDays: options.recentDays,
      items: [
        {
          kind: "file",
          score: 0.9,
          file: {
            name: TARGET_REL,
            path: `~/projects/demo/${TARGET_REL}`,
            mtime: new Date().toISOString(),
            sizeBytes: 12,
            ext: ".txt",
          },
        },
      ],
    });
  }
}

// ===========================================================================
// 测试
// ===========================================================================

describe("任务 17.2：端到端冒烟测试（mock LLM 跑通主动察觉闭环）", () => {
  let sandboxDir: string;

  beforeEach(() => {
    // 真实 sandbox：os.tmpdir() 下的临时目录，所有落地都发生在此，测试后清理。
    sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), "pad-e2e-smoke-"));
  });

  afterEach(() => {
    if (sandboxDir) {
      fs.rmSync(sandboxDir, { recursive: true, force: true });
    }
  });

  it("scan→analyze→clarify→scope→backup→execute→verify→deliver→accept 全闭环：状态 accepted、文件真实落地、验收报告含证据", async () => {
    const llm = new MockLlmProvider();
    const scanner = new MockScanner();

    // buildApp 注入 mock LLM + mock scanner；scanOptions.homeDir 指向临时目录。
    const app = buildApp({
      llmProvider: llm,
      scanner,
      scanOptions: { recentDays: 7, topN: 15, homeDir: sandboxDir },
    });
    const { orchestrator } = app;

    // --- 1) 扫描 → 分析 → 察觉呈现 -------------------------------------------
    const scanResult = await orchestrator.scan();
    expect(scanResult.ok).toBe(true);
    expect(orchestrator.getState()).toBe(SessionState.AwarenessPresented);

    const items = orchestrator.getSession().awarenessItems ?? [];
    expect(items.length).toBeGreaterThan(0);
    const itemId = items[0].id;

    // --- 2) 接受察觉 → 进入澄清（首轮产出提问）-------------------------------
    const accept = await orchestrator.acceptAwareness(itemId);
    expect(accept.ok).toBe(true);
    expect(orchestrator.getState()).toBe(SessionState.Clarifying);

    // --- 3) 回答澄清问题 → 信息充分，产出 Task_Frame -------------------------
    const answer: UserAnswer = {
      questionId: "q1",
      text: `请写入「${FILE_CONTENT}」`,
    };
    const answered = await orchestrator.answer(answer);
    expect(answered.ok).toBe(true);
    expect(orchestrator.getState()).toBe(SessionState.AwaitingUnderstanding);

    const taskFrame = orchestrator.getSession().taskFrame;
    expect(taskFrame).toBeDefined();
    expect(taskFrame?.acceptanceTests.length).toBeGreaterThan(0);
    expect(taskFrame?.primaryTargets).toContain(TARGET_REL);

    // --- 4) 最终理解确认 → 定界 ----------------------------------------------
    const confirmU = await orchestrator.confirmUnderstanding();
    expect(confirmU.ok).toBe(true);
    expect(orchestrator.getState()).toBe(SessionState.ScopeConfirm);

    // --- 5) 确认 Working_Directory（指向临时 sandbox）→ 最终执行确认入口 ------
    const confirmScope = orchestrator.confirmScope(sandboxDir);
    expect(confirmScope.ok).toBe(true);
    expect(orchestrator.getState()).toBe(SessionState.ReadyConfirm);

    // --- 6) 开始执行 → 备份 → 执行（后台）-----------------------------------
    const start = await orchestrator.startExecution();
    expect(start.ok).toBe(true);

    // 等待后台执行 + 强制验收阶段结算（execute → verify → delivered）。
    await orchestrator.whenExecutionSettled();
    expect(orchestrator.getState()).toBe(SessionState.Delivered);

    // --- 7) 用户"确认完成"验收 ----------------------------------------------
    const acceptDelivery = orchestrator.acceptDelivery();
    expect(acceptDelivery.ok).toBe(true);

    // ===== 断言 1：最终状态 accepted =====
    expect(orchestrator.getState()).toBe(SessionState.Accepted);
    expect(orchestrator.getSession().accepted).toBe(true);

    // ===== 断言 2：执行真实落地了文件（sandbox 内确被创建且内容正确）=====
    const writtenPath = path.join(sandboxDir, TARGET_REL);
    expect(fs.existsSync(writtenPath)).toBe(true);
    expect(fs.readFileSync(writtenPath, "utf8")).toBe(FILE_CONTENT);

    // ===== 断言 3：验收报告含证据 =====
    const report = orchestrator.getSession().deliveryReport;
    expect(report).toBeDefined();
    // 逐条验收测试结果：非空且全部通过（file: 断言在 sandbox 内真实检验）。
    expect(report?.acceptanceTestResults.length).toBeGreaterThan(0);
    expect(report?.acceptanceTestResults.every((r) => r.passed)).toBe(true);
    expect(report?.hasFailures).toBe(false);
    // 改动文件证据：包含对 output.txt 的 diff 条目（证据可回溯到真实落地）。
    expect(report?.fileDiffs.some((d) => d.path.includes(TARGET_REL))).toBe(true);

    // 附带证明闭环确实流经了各模块（analyzer / clarifier / executor）。
    expect(llm.stats.analyze).toBeGreaterThan(0);
    expect(llm.stats.begin).toBeGreaterThan(0);
    expect(llm.stats.next).toBeGreaterThanOrEqual(2);
    expect(llm.stats.sufficient).toBeGreaterThan(0);
    expect(llm.stats.tool).toBeGreaterThanOrEqual(2);

    // 执行日志含真实落地的 write_file（ok 且未被安全门拦截）。
    const writeInv = (orchestrator.getSession().executionLog ?? []).find(
      (inv) => inv.tc.name === "write_file",
    );
    expect(writeInv?.result.ok).toBe(true);
    expect(writeInv?.blocked).toBeFalsy();
  });
});
