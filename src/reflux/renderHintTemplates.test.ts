/**
 * 平台渲染提示模板库（renderHintTemplates.ts）单元测试。
 *
 * 注入桩 query（不连真实 PG），覆盖任务 17 / Req 15.13：
 *  - seedRenderHintTemplates 对 mac/win/linux 三平台各执行一次幂等 upsert（ON CONFLICT DO UPDATE）；
 *  - 写入参数为 (os, template)，模板取自内置 RENDER_HINT_TEMPLATES；
 *  - upsertRenderHintTemplate 单条入口可随平台扩展更新（含覆盖既有平台）；
 *  - 三平台模板内容符合 buildHostEnvHint 命令语法规则（PowerShell / osascript / POSIX）。
 *
 * _Requirements: 15.13_
 */

import { describe, expect, it, vi } from "vitest";

import {
  RENDER_HINT_TEMPLATES,
  seedRenderHintTemplates,
  upsertRenderHintTemplate,
  type RenderHintQueryFn,
} from "./renderHintTemplates.js";

/** 构造一个记录调用的 query 桩。 */
function makeQueryStub() {
  const calls: Array<{ text: string; params?: unknown[] }> = [];
  const stub: RenderHintQueryFn = vi.fn(async (text: string, params?: unknown[]) => {
    calls.push({ text, params });
    return { rows: [] };
  });
  return { stub, calls };
}

describe("renderHintTemplates · seedRenderHintTemplates", () => {
  it("对 mac/win/linux 三平台各执行一次 upsert（参数为 os + 内置模板）", async () => {
    const { stub, calls } = makeQueryStub();

    await seedRenderHintTemplates(stub);

    // 三平台各一次写入。
    expect(calls).toHaveLength(3);
    const writtenOs = calls.map((c) => c.params?.[0]);
    expect(writtenOs).toEqual(["mac", "win", "linux"]);

    // 每条写入的模板与内置常量一致。
    for (const c of calls) {
      const os = c.params?.[0] as "mac" | "win" | "linux";
      expect(c.params?.[1]).toBe(RENDER_HINT_TEMPLATES[os]);
    }
  });

  it("使用 ON CONFLICT DO UPDATE 保证幂等（二次调用不报错、仍是 upsert 语义）", async () => {
    const { stub, calls } = makeQueryStub();

    await seedRenderHintTemplates(stub);
    await seedRenderHintTemplates(stub);

    expect(calls).toHaveLength(6);
    for (const c of calls) {
      expect(c.text).toMatch(/INSERT INTO render_hint_template/);
      expect(c.text).toMatch(/ON CONFLICT \(os\)/);
      expect(c.text).toMatch(/DO UPDATE SET/);
    }
  });
});

describe("renderHintTemplates · upsertRenderHintTemplate（随平台扩展更新入口）", () => {
  it("可写入/覆盖单个平台模板", async () => {
    const { stub, calls } = makeQueryStub();

    await upsertRenderHintTemplate("win", "自定义 win 模板", stub);

    expect(calls).toHaveLength(1);
    expect(calls[0].params).toEqual(["win", "自定义 win 模板"]);
    expect(calls[0].text).toMatch(/ON CONFLICT \(os\)/);
  });
});

describe("renderHintTemplates · 模板内容符合 buildHostEnvHint 语法规则", () => {
  it("win 模板用 PowerShell、禁 macOS 命令", () => {
    expect(RENDER_HINT_TEMPLATES.win).toMatch(/PowerShell/);
    expect(RENDER_HINT_TEMPLATES.win).toMatch(/Get-Process/);
    expect(RENDER_HINT_TEMPLATES.win).toMatch(/osascript/); // 出现在「禁止使用」说明中
  });

  it("mac 模板用 osascript/pbpaste/open", () => {
    expect(RENDER_HINT_TEMPLATES.mac).toMatch(/osascript/);
    expect(RENDER_HINT_TEMPLATES.mac).toMatch(/pbpaste/);
    expect(RENDER_HINT_TEMPLATES.mac).toMatch(/open/);
  });

  it("linux 模板用 POSIX sh / GNU 工具", () => {
    expect(RENDER_HINT_TEMPLATES.linux).toMatch(/POSIX sh/);
    expect(RENDER_HINT_TEMPLATES.linux).toMatch(/xdg-open/);
  });
});
