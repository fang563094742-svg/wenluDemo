// Feature: proactive-awareness-demo, Property 2: *For any* 含任意 mtime 的文件元信息集合，规则粗筛结果中每个条目的 mtime 均在最近 `recentDays` 天内，且每个条目仅含元信息字段（name/path/mtime/size/ext），不含任何正文内容。
//
// **Validates: Requirements 3.1**
//
// 本测试聚焦任务 4.6 的被测单元 `MacScanner.scan()`（src/scanner/macScanner.ts）两段式扫描的
// 「阶段1 规则粗筛」时间窗与元信息纯度。策略：在 os.tmpdir() 下用生成的文件名 + 受控 mtime
// 构造一棵临时目录树（部分文件落在 `recentDays` 时间窗内、部分落在窗外），调用真实 `scan()`，
// 断言以下三类不变量（均为 Property 2 的不同侧面，同属单条 Property 2，不引入新 Property）：
//   1. 时间窗：扫描结果只含窗口内的文件（窗外文件被排除），且每个文件条目的 mtime ≥ now-recentDays；
//   2. 元信息纯度（结构）：每个文件条目恰好只含元信息字段 {name, path, mtime, sizeBytes, ext}，
//      且 ScanSummaryItem 不含任何正文字段；
//   3. 元信息纯度（内容）：写入文件的正文内容（哨兵字符串）绝不出现在产出的 Scan_Summary 中。
// 平台说明：当前测试机为 macOS（darwin），`scan()` 正常运行；若在非 macOS 平台运行，`scan()`
// 会抛 `ScanError`（"暂不支持"），此时按 design 用 vitest 条件跳过（见 describe.skipIf）。
//
// 安全：所有临时文件 / 目录均创建于 os.tmpdir() 下，每个用例结束即 rmSync 清理；绝不触及项目目录外的用户路径。

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { MacScanner } from "../../src/scanner/macScanner.js";
import type { Scan_Summary, ScanSummaryItem } from "../../src/scanner/types.js";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;
const IS_DARWIN = process.platform === "darwin";

/** FileMeta 的全部合法元信息字段（且仅此 5 个），用于结构纯度断言。 */
const FILE_META_KEYS = ["ext", "mtime", "name", "path", "sizeBytes"] as const;

/** 写入临时文件的正文哨兵：绝不应出现在仅含元信息的 Scan_Summary 中。 */
const BODY_SENTINEL = "PROPERTY2_BODY_SENTINEL_SHOULD_NEVER_LEAK";

/** 绝不应作为对象键出现的"正文类"字段名（精确匹配，避免误伤 sizeBytes）。 */
const FORBIDDEN_CONTENT_KEYS: ReadonlySet<string> = new Set([
  "content",
  "contents",
  "body",
  "text",
  "raw",
  "data",
  "buffer",
]);

// ---------------------------------------------------------------------------
// 生成器
// ---------------------------------------------------------------------------

/** 安全文件名段：仅 [a-z0-9_]，非空；不含 "." / "/" / 空白，绝不命中排除红线或加密扩展名。 */
const safeName = fc
  .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789_".split("")), {
    minLength: 1,
    maxLength: 8,
  })
  .map((cs) => cs.join(""));

/** 非加密、非敏感、非噪音的安全扩展名（与排除红线 / 工具噪音规则无交集）。 */
const cleanExt = fc.constantFrom("txt", "ts", "md", "js", "json", "csv");

/** 单个文件规格：名/扩展名 + 是否落在时间窗内 + 窗内位置 / 窗外额外天数。 */
interface FileSpec {
  name: string;
  ext: string;
  inWindow: boolean;
  /** 窗内时：mtime 距 now 的比例（0..0.9，留 ≥10% 窗口余量以吸收扫描耗时）。 */
  windowFrac: number;
  /** 窗外时：超出窗口的额外天数（≥1 天，确保明确落在窗外）。 */
  extraDays: number;
}

const fileSpecArb: fc.Arbitrary<FileSpec> = fc.record({
  name: safeName,
  ext: cleanExt,
  inWindow: fc.boolean(),
  windowFrac: fc.double({ min: 0, max: 0.9, noNaN: true, noDefaultInfinity: true }),
  extraDays: fc.integer({ min: 1, max: 60 }),
});

/** 文件规格集合（允许为空，覆盖边界）。 */
const specsArb = fc.array(fileSpecArb, { maxLength: 6 });

/** 时间窗天数（恒正；scan 内部对 ≤0 归一为 7，这里固定取正以精确控制窗口）。 */
const recentDaysArb = fc.integer({ min: 1, max: 30 });

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

/** 递归检查对象图中是否出现"正文类"禁用键（精确键名匹配）。命中返回该键名，否则 null。 */
function findForbiddenKey(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const el of value) {
      const hit = findForbiddenKey(el);
      if (hit) return hit;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_CONTENT_KEYS.has(k)) return k;
      const hit = findForbiddenKey(v);
      if (hit) return hit;
    }
  }
  return null;
}

/** 断言单个 file 条目的字段恰好是 5 个元信息字段，且 git/app 槽位为空。 */
function assertFileItemMetaOnly(item: ScanSummaryItem): void {
  expect(item.kind).toBe("file");
  expect(item.file).toBeDefined();
  expect(item.git).toBeUndefined();
  expect(item.app).toBeUndefined();
  // ScanSummaryItem 顶层键只可能是 kind/score/file（git/app 未填充）。
  for (const key of Object.keys(item)) {
    expect(["kind", "score", "file"]).toContain(key);
  }
  // file 子对象恰好只含元信息字段（不多不少）。
  expect(Object.keys(item.file!).sort()).toEqual([...FILE_META_KEYS]);
}

const scanner = new MacScanner();

// ---------------------------------------------------------------------------
// Property 2
// ---------------------------------------------------------------------------

describe.skipIf(!IS_DARWIN)("Property 2: 粗筛时间窗与元信息纯度", () => {
  it("扫描结果只含时间窗内文件，每个条目仅含元信息字段且不含任何正文", async () => {
    await fc.assert(
      fc.asyncProperty(specsArb, recentDaysArb, async (specs, recentDays) => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "pad-scan2-"));
        try {
          const windowMs = recentDays * DAY_MS;
          // t0 captured before scan: scan 内部的 now ≥ t0，故 scanCutoff ≥ t0 - windowMs，
          // 据此可对结果 mtime 取下界 (t0 - windowMs) 做 sound 断言。
          const t0 = Date.now();

          // 在临时根下平铺写入文件并设定受控 mtime；按 index 保证文件名唯一、可回溯到规格。
          const expectedByName = new Map<string, { inWindow: boolean }>();
          specs.forEach((s, i) => {
            const fileName = `${i}_${s.name}.${s.ext}`;
            const filePath = path.join(root, fileName);
            // 写入真实正文哨兵：用于验证扫描产物绝不含正文内容。
            fs.writeFileSync(filePath, BODY_SENTINEL);
            const mtimeMs = s.inWindow
              ? t0 - Math.floor(s.windowFrac * windowMs) // 窗内：留 ≥10% 余量
              : t0 - windowMs - s.extraDays * DAY_MS; // 窗外：明确超出窗口 ≥1 天
            const when = new Date(mtimeMs);
            fs.utimesSync(filePath, when, when);
            expectedByName.set(fileName, { inWindow: s.inWindow });
          });

          // topN 取极大值：让"时间窗"成为唯一的纳入/排除因素（而非 Top N 截断），
          // 且不被并存的在用 App / git 条目挤占名额。
          const summary: Scan_Summary = await scanner.scan({
            recentDays,
            topN: 1_000_000,
            homeDir: root,
          });

          const fileItems = summary.items.filter((it) => it.kind === "file");
          const resultNames = new Set(fileItems.map((it) => it.file!.name));

          // (1) 时间窗：窗内文件全部入选、窗外文件全部被排除。
          for (const [fileName, { inWindow }] of expectedByName) {
            expect(resultNames.has(fileName)).toBe(inWindow);
          }

          // (1') 每个结果文件条目的 mtime ≥ now - recentDays（取 sound 下界 t0 - windowMs）。
          const lowerBound = t0 - windowMs;
          for (const it of fileItems) {
            expect(Date.parse(it.file!.mtime)).toBeGreaterThanOrEqual(lowerBound);
          }

          // (2) 结构纯度：每个文件条目恰好只含 5 个元信息字段，无正文槽位。
          for (const it of fileItems) {
            assertFileItemMetaOnly(it);
          }

          // (2') 全摘要（含 git/app 条目）不出现任何"正文类"禁用键。
          expect(findForbiddenKey(summary)).toBeNull();

          // (3) 内容纯度：写入的正文哨兵绝不出现在整份 Scan_Summary 序列化结果中。
          expect(JSON.stringify(summary).includes(BODY_SENTINEL)).toBe(false);
        } finally {
          fs.rmSync(root, { recursive: true, force: true });
        }
      }),
      { numRuns: 100 },
    );
  }, 120_000);
});
