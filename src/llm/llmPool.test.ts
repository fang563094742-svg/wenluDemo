/**
 * LLM 池（LlmPool）· 单元测试
 * ------------------------------------------------------------------
 * 覆盖大脑去单点的核心保证：
 *   1. 主端点成功 → 直接用，不碰备用/本地。
 *   2. 主端点失败 → 故障转移到备用/本地，呼吸不死。
 *   3. 全失败 → 抛 LlmPoolExhaustedError（调用方据此挂起，不崩溃）。
 *   4. 熔断：某成员连续失败超阈值后被暂时跳过；本地成员永不被跳过（最后防线）。
 */

import { describe, it, expect, vi } from "vitest";
import { LlmPool, LlmPoolExhaustedError, type LlmPoolMember } from "./llmPool.js";
import type { LLM_Provider, LlmToolResponse } from "./llmProvider.js";

/** 造一个可控成败的假 provider。 */
function fakeProvider(key: string, behavior: () => Promise<LlmToolResponse>): LLM_Provider {
  return {
    providerKey: key,
    complete: async () => ({ text: key }),
    completeWithTools: behavior,
  };
}

const REQ = { system: "", messages: [], tools: [] };

describe("LlmPool · 大脑去单点故障转移", () => {
  it("主端点成功：不触碰备用/本地", async () => {
    const backupFn = vi.fn(async () => ({ finalText: "backup" }));
    const members: LlmPoolMember[] = [
      { provider: fakeProvider("primary", async () => ({ finalText: "primary" })), role: "relay-primary" },
      { provider: fakeProvider("backup", backupFn), role: "relay-backup" },
    ];
    const pool = new LlmPool(members);
    const res = await pool.completeWithTools(REQ);
    expect(res.finalText).toBe("primary");
    expect(backupFn).not.toHaveBeenCalled();
  });

  it("主端点失败：故障转移到备用并成功", async () => {
    const members: LlmPoolMember[] = [
      { provider: fakeProvider("primary", async () => { throw new Error("primary down"); }), role: "relay-primary" },
      { provider: fakeProvider("backup", async () => ({ finalText: "backup" })), role: "relay-backup" },
    ];
    const pool = new LlmPool(members);
    const res = await pool.completeWithTools(REQ);
    expect(res.finalText).toBe("backup");
  });

  it("中转全挂：本地模型兜底接管", async () => {
    const members: LlmPoolMember[] = [
      { provider: fakeProvider("primary", async () => { throw new Error("down"); }), role: "relay-primary" },
      { provider: fakeProvider("backup", async () => { throw new Error("down"); }), role: "relay-backup" },
      { provider: fakeProvider("local", async () => ({ finalText: "local-brain" })), role: "local", isLocal: true },
    ];
    const pool = new LlmPool(members);
    const res = await pool.completeWithTools(REQ);
    expect(res.finalText).toBe("local-brain");
  });

  it("全部失败：抛 LlmPoolExhaustedError 含尝试链", async () => {
    const members: LlmPoolMember[] = [
      { provider: fakeProvider("primary", async () => { throw new Error("d1"); }), role: "relay-primary" },
      { provider: fakeProvider("local", async () => { throw new Error("d2"); }), role: "local", isLocal: true },
    ];
    const pool = new LlmPool(members);
    await expect(pool.completeWithTools(REQ)).rejects.toBeInstanceOf(LlmPoolExhaustedError);
  });

  it("熔断：成员连续失败超阈值后被跳过，但本地永不跳过", async () => {
    let primaryCalls = 0;
    const primary = fakeProvider("primary", async () => { primaryCalls++; throw new Error("down"); });
    const local = fakeProvider("local", async () => ({ finalText: "local" }));
    const pool = new LlmPool(
      [
        { provider: primary, role: "relay-primary" },
        { provider: local, role: "local", isLocal: true },
      ],
      { breakerThreshold: 2, breakerCooldownMs: 100000 },
    );
    // 跑 3 轮：primary 连失 2 次后熔断，第 3 轮应被跳过（不再调用）。
    await pool.completeWithTools(REQ);
    await pool.completeWithTools(REQ);
    const callsBefore = primaryCalls;
    await pool.completeWithTools(REQ);
    expect(primaryCalls).toBe(callsBefore); // 第3轮 primary 被熔断跳过
  });

  it("恢复：熔断的成员成功一次后复位", async () => {
    let shouldFail = true;
    const primary = fakeProvider("primary", async () => {
      if (shouldFail) throw new Error("down");
      return { finalText: "recovered" };
    });
    const local = fakeProvider("local", async () => ({ finalText: "local" }));
    const events: string[] = [];
    const pool = new LlmPool(
      [
        { provider: primary, role: "relay-primary" },
        { provider: local, role: "local", isLocal: true },
      ],
      { breakerThreshold: 5, onEvent: (e) => events.push(`${e.kind}:${e.role}`) },
    );
    await pool.completeWithTools(REQ); // primary 失败 → local 接管
    shouldFail = false;
    const res = await pool.completeWithTools(REQ); // primary 恢复
    expect(res.finalText).toBe("recovered");
    expect(events.some((e) => e.startsWith("recovered"))).toBe(true);
  });

  it("空成员列表：构造即抛错", () => {
    expect(() => new LlmPool([])).toThrow();
  });
});
