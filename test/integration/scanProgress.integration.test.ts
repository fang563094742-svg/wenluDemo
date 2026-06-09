/**
 * 任务 4.9：扫描具身化流式进度集成测试（vitest，非 property）。
 *
 * 被测：`src/scanner/macScanner.ts` 的 `MacScanner.scan(options, onProgress)`——
 * 阶段1 粗筛过程中，每发现一批新文件 / git 仓库 / 在用 App，即通过 `onProgress`
 * 推送一条 `{ type:"scan:progress", found:[...] }`（扫描具身化，可选增强，R16.2）。
 *
 * 本测试按 design「可选增强项的测试归属（非 property）」处理：**不新增 Correctness
 * Property**，仅以 1 个集成测试覆盖（涉及真实文件系统遍历，归 integration）：
 *  1. 传入 `onProgress` 回调：在 `os.tmpdir()` 下构造含近期文件的临时目录，断言粗筛
 *     过程中至少推送一条 `scan:progress`，且 `found` 内容均为**元信息级线索**
 *     （文件名 / 仓库名 / App 名），**绝不含文件正文**。
 *  2. 不传 `onProgress`：退化为静默扫描——不推送任何事件、且文件类条目结果与带回调
 *     的扫描一致（行为不变，非破坏性追加）。
 *  3. 非 macOS 平台：条件跳过（`MacScanner` 仅支持 darwin）。
 *
 * 安全边界：所有临时目录 / 文件均创建于 `os.tmpdir()` 下、测试结束清理；
 * 绝不触及项目目录外的用户真实路径。
 *
 * _Requirements: 16.2, 4.1_
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { MacScanner } from "../../src/scanner/macScanner.js";
import type {
  ScanOptions,
  ScanProgressEvent,
  Scan_Summary,
  ScanSummaryItem,
} from "../../src/scanner/types.js";

// 仅在 macOS（darwin）下运行；其余平台条件跳过（MacScanner.scan 在非 darwin 抛 ScanError）。
const describeMac = describe.skipIf(process.platform !== "darwin");

/** 写入文件的“正文哨兵”：绝不应出现在任何 `scan:progress` 线索中。 */
const BODY_SENTINEL = "SECRET_BODY_SENTINEL_正文绝不应出现在线索流中_1f2e3d";

/**
 * 测试夹具：`os.tmpdir()` 下的临时主目录，含 8 个近期文件（文件名带哨兵后缀以便断言
 * 线索来源）。8 > 批大小 6，可触发粗筛过程中的“中途”推送（而非仅收尾 flush）。
 */
interface Fixture {
  homeDir: string;
  fileNames: string[];
}

let fx: Fixture;

beforeAll(() => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pad-scanprog-"));
  const fileNames: string[] = [];
  for (let i = 0; i < 8; i += 1) {
    const name = `clue-file-${i}.md`;
    fileNames.push(name);
    // 文件名是元信息级线索；正文写入哨兵，用于断言线索流绝不泄露正文。
    fs.writeFileSync(
      path.join(homeDir, name),
      `# ${name}\n${BODY_SENTINEL}\n正文内容应仅存在于文件内部，不应被扫描读取或外传。\n`,
    );
  }
  fx = { homeDir, fileNames };
});

afterAll(() => {
  if (fx?.homeDir) {
    fs.rmSync(fx.homeDir, { recursive: true, force: true });
  }
});

/** 标准扫描入参：时间窗 7 天、topN 取大值确保临时目录全部文件入选（便于一致性比较）。 */
function makeOptions(homeDir: string): ScanOptions {
  return { recentDays: 7, topN: 100, homeDir };
}

/** 从 Scan_Summary 中提取文件类条目的路径集合（升序），用于“结果一致”比较。 */
function filePaths(summary: Scan_Summary): string[] {
  return summary.items
    .filter((it: ScanSummaryItem) => it.kind === "file" && it.file)
    .map((it) => it.file!.path)
    .sort();
}

describeMac("任务 4.9：扫描具身化流式进度（scan:progress）集成测试", () => {
  it("传入 onProgress：粗筛过程中至少推送一条 scan:progress，且 found 均为元信息级线索（不含正文）", async () => {
    const scanner = new MacScanner();
    const events: ScanProgressEvent[] = [];

    const summary = await scanner.scan(makeOptions(fx.homeDir), (event) => {
      events.push(event);
    });

    // 至少推送一条进度事件。
    expect(events.length).toBeGreaterThanOrEqual(1);

    // 每条事件形态正确：type 判别标签 + 非空 found 字符串数组。
    for (const event of events) {
      expect(event.type).toBe("scan:progress");
      expect(Array.isArray(event.found)).toBe(true);
      expect(event.found.length).toBeGreaterThan(0);
      for (const clue of event.found) {
        expect(typeof clue).toBe("string");
        // 元信息级线索绝不含文件正文哨兵。
        expect(clue.includes(BODY_SENTINEL)).toBe(false);
      }
    }

    // 至少一条线索可回溯到我们构造的近期文件名（证明确实来自阶段1 粗筛的真实发现）。
    const allClues = events.flatMap((e) => e.found);
    const sawConstructedFile = fx.fileNames.some((name) => allClues.includes(name));
    expect(sawConstructedFile).toBe(true);

    // 整个线索流中绝不出现正文哨兵（聚合再确认一次）。
    expect(allClues.some((clue) => clue.includes(BODY_SENTINEL))).toBe(false);

    // 扫描产物仍是合法 Scan_Summary（darwin 平台、含我们的文件条目）。
    expect(summary.platform).toBe("darwin");
    expect(filePaths(summary).length).toBe(fx.fileNames.length);
  });

  it("不传 onProgress：静默退化（不推送任何事件），且文件类结果与带回调扫描一致（行为不变）", async () => {
    const scanner = new MacScanner();

    // 带回调扫描：收集事件。
    const events: ScanProgressEvent[] = [];
    const withCb = await scanner.scan(makeOptions(fx.homeDir), (event) => {
      events.push(event);
    });

    // 不带回调扫描：应完全静默（无从推送），且不抛错。
    const silent = await scanner.scan(makeOptions(fx.homeDir));

    // 两次扫描的文件类条目（确定性来源：同一临时目录）应完全一致——onProgress 仅为
    // 非破坏性的旁路通知，不改变扫描结果。
    expect(filePaths(silent)).toEqual(filePaths(withCb));

    // 静默扫描同样产出合法 Scan_Summary。
    expect(silent.platform).toBe("darwin");
    expect(filePaths(silent).length).toBe(fx.fileNames.length);
  });
});
