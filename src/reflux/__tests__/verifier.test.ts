/**
 * Verifier（验证）单元测试。
 *
 * 全部依赖注入式 mock（mock connector + mock verification + mock store + mock softReviewer），
 * 独立可跑（不连真实 PG / 真实连接器 / 真实 LLM）。覆盖任务 8 要求的四类行为：
 *  1. 安全拦截：危险命令命中黑名单 → safetyBlocked，引擎/连接器均不被调用。
 *  2. server vs connector 标记：viaConnector=false → server-verified；=true → connector-verified。
 *  3. 向上兼容一期 verified：connector-verified 回填 provenance.verifiedCount。
 *  4. 降级：connector-verified 变体连续失败 → fail_streak++ 降分；达阈值 → unverified。
 *
 * _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 8.1, 8.2, 8.3, 8.4, 8.6, 15.8_
 */

import { describe, expect, it, vi } from "vitest";

import {
  createVerifier,
  type ConnectorLike,
  type SoftSkillReviewer,
  type VerifierStore,
  type DowngradeResult,
} from "../verifier.js";
import { DEFAULT_REFLUX_CONFIG } from "../config.js";
import type { VariantOS, VerifyStatus } from "../types.js";
import type { VerificationEngine, VerificationResult } from "../../verification/index.js";

// ── mock 验证引擎：按构造时给定的 verdict 返回固定结果，并记录被调用情况 ──
function makeMockEngine(verdict: "passed" | "failed"): VerificationEngine & { calls: number } {
  const engine = {
    calls: 0,
    async verify(taskId: string): Promise<VerificationResult> {
      engine.calls++;
      const passed = verdict === "passed";
      return {
        taskId,
        timestamp: new Date().toISOString(),
        assertions: [],
        overallVerdict: verdict,
        hardGatesPassed: passed,
        softScore: passed ? 1 : 0,
        totalDurationMs: 1,
        summary: `mock ${verdict}`,
      };
    },
    async verifyLegacy(taskId: string): Promise<VerificationResult> {
      return engine.verify(taskId);
    },
  };
  return engine;
}

// ── mock 连接器：记录 exec 调用次数；activeInfo 提供平台标识 ──
function makeMockConnector(): ConnectorLike & { execCalls: number } {
  const c = {
    execCalls: 0,
    async request<T>(_op: "exec", _args: Record<string, unknown>): Promise<T> {
      c.execCalls++;
      return { ok: true, stdout: "ok", code: 0 } as T;
    },
    isOnline: () => true,
    activeInfo: () => ({ platform: "win", machineLabel: "user-pc" }),
  };
  return c;
}

// ── mock VerifierStore：内存记录变体状态/回填/降级 ──
interface MemVariant {
  verify_status: VerifyStatus;
  verified_by?: string;
  fail_streak: number;
}
function makeMockStore() {
  const variants = new Map<string, MemVariant>();
  let verifiedCount = 0;
  let successRate = 1.0;
  const key = (skillId: string, os: VariantOS) => `${skillId}:${os}`;
  const ensure = (k: string): MemVariant => {
    let v = variants.get(k);
    if (!v) {
      v = { verify_status: "unverified", fail_streak: 0 };
      variants.set(k, v);
    }
    return v;
  };
  const store: VerifierStore = {
    async markServerVerified(skillId, os) {
      const v = ensure(key(skillId, os));
      if (v.verify_status !== "connector-verified") v.verify_status = "server-verified";
    },
    async markConnectorVerified(skillId, os, verifiedBy) {
      const v = ensure(key(skillId, os));
      v.verify_status = "connector-verified";
      v.verified_by = verifiedBy;
      v.fail_streak = 0;
      verifiedCount += 1; // 回填 provenance.verifiedCount
    },
    async recordVariantFailure(skillId, os, downgradeStreak): Promise<DowngradeResult> {
      const v = ensure(key(skillId, os));
      v.fail_streak += 1;
      successRate = Math.max(0, successRate * 0.8);
      const downgraded = v.fail_streak >= downgradeStreak;
      if (downgraded) {
        v.verify_status = "unverified";
        v.verified_by = undefined;
      }
      return { failStreak: v.fail_streak, downgraded };
    },
  };
  return {
    store,
    getVariant: (skillId: string, os: VariantOS) => variants.get(key(skillId, os)),
    getVerifiedCount: () => verifiedCount,
    getSuccessRate: () => successRate,
  };
}

describe("Verifier · 安全预审拦截（Req 7.1）", () => {
  it("危险命令命中黑名单即拦截，不调用引擎或连接器", async () => {
    const engine = makeMockEngine("passed");
    const connector = makeMockConnector();
    const { store } = makeMockStore();
    const verifier = createVerifier({
      serverEngine: engine,
      connectorEngineFactory: () => engine,
      connector,
      store,
    });

    const res = await verifier.verifyExecutable({
      skillId: "s1",
      command: "sudo rm -rf /",
      os: "linux",
      viaConnector: true,
    });

    expect(res.safetyBlocked).toBe(true);
    expect(res.passed).toBe(false);
    expect(res.status).toBe("unverified");
    expect(engine.calls).toBe(0);
    expect(connector.execCalls).toBe(0);
  });

  it("verifyCmd 命中危险模式同样被拦截", async () => {
    const engine = makeMockEngine("passed");
    const verifier = createVerifier({ serverEngine: engine });
    const res = await verifier.verifyExecutable({
      command: "echo hello",
      verifyCmd: "DROP TABLE users",
      os: "linux",
      viaConnector: false,
    });
    expect(res.safetyBlocked).toBe(true);
    expect(engine.calls).toBe(0);
  });
});

describe("Verifier · server vs connector 标记（Req 8.1/8.2/8.3）", () => {
  it("viaConnector=false 跑通仅记 server-verified（弱证据）", async () => {
    const engine = makeMockEngine("passed");
    const { store, getVariant, getVerifiedCount } = makeMockStore();
    const verifier = createVerifier({ serverEngine: engine, store });

    const res = await verifier.verifyExecutable({
      skillId: "s1",
      command: "node --version",
      os: "linux",
      viaConnector: false,
    });

    expect(res.status).toBe("server-verified");
    expect(res.passed).toBe(true);
    expect(getVariant("s1", "linux")?.verify_status).toBe("server-verified");
    // server-verified 不满足一期 verified，不回填 verifiedCount。
    expect(getVerifiedCount()).toBe(0);
  });

  it("viaConnector=true 跑通记该平台 connector-verified，并取连接器标识为 verified_by", async () => {
    const engine = makeMockEngine("passed");
    const connector = makeMockConnector();
    const { store, getVariant } = makeMockStore();
    const verifier = createVerifier({
      connectorEngineFactory: () => engine,
      connector,
      store,
    });

    const res = await verifier.verifyExecutable({
      skillId: "s1",
      command: "node --version",
      os: "win",
      viaConnector: true,
    });

    expect(res.status).toBe("connector-verified");
    expect(res.passed).toBe(true);
    expect(res.verifiedBy).toBe("user-pc");
    expect(getVariant("s1", "win")?.verify_status).toBe("connector-verified");
  });

  it("viaConnector=true 但无连接器在线 → unverified", async () => {
    const engine = makeMockEngine("passed");
    const verifier = createVerifier({ connectorEngineFactory: () => engine });
    const res = await verifier.verifyExecutable({
      command: "node --version",
      os: "win",
      viaConnector: true,
    });
    expect(res.status).toBe("unverified");
    expect(res.passed).toBe(false);
  });

  it("连接器执行未通过 → unverified（不标 connector-verified）", async () => {
    const engine = makeMockEngine("failed");
    const connector = makeMockConnector();
    const { store, getVariant } = makeMockStore();
    const verifier = createVerifier({ connectorEngineFactory: () => engine, connector, store });
    const res = await verifier.verifyExecutable({
      skillId: "s1",
      command: "node --version",
      os: "win",
      viaConnector: true,
    });
    expect(res.status).toBe("unverified");
    expect(res.passed).toBe(false);
    expect(getVariant("s1", "win")).toBeUndefined();
  });
});

describe("Verifier · 向上兼容一期 verified（Req 7.5）", () => {
  it("connector-verified 回填 provenance.verifiedCount，server-verified 不回填", async () => {
    const passEngine = makeMockEngine("passed");
    const connector = makeMockConnector();
    const { store, getVerifiedCount } = makeMockStore();
    const verifier = createVerifier({
      serverEngine: passEngine,
      connectorEngineFactory: () => passEngine,
      connector,
      store,
    });

    await verifier.verifyExecutable({ skillId: "s1", command: "a", os: "linux", viaConnector: false });
    expect(getVerifiedCount()).toBe(0);

    await verifier.verifyExecutable({ skillId: "s1", command: "a", os: "win", viaConnector: true });
    // 凡 connector-verified 即满足一期 verified → 回填一次。
    expect(getVerifiedCount()).toBe(1);
  });
});

describe("Verifier · 降级（Req 8.6）", () => {
  it("连续失败累加 fail_streak 并降分；达 Connector_Downgrade_Streak 降为 unverified", async () => {
    const { store, getVariant, getSuccessRate } = makeMockStore();
    // 先把变体标为 connector-verified，再制造连续失败。
    await store.markConnectorVerified("s1", "win", "user-pc");
    const verifier = createVerifier({
      store,
      config: { ...DEFAULT_REFLUX_CONFIG, Connector_Downgrade_Streak: 3 },
    });

    const r1 = await verifier.downgradeOnFailure("s1", "win");
    expect(r1.failStreak).toBe(1);
    expect(r1.downgraded).toBe(false);
    expect(getVariant("s1", "win")?.verify_status).toBe("connector-verified");

    const r2 = await verifier.downgradeOnFailure("s1", "win");
    expect(r2.downgraded).toBe(false);

    const r3 = await verifier.downgradeOnFailure("s1", "win");
    expect(r3.failStreak).toBe(3);
    expect(r3.downgraded).toBe(true);
    expect(getVariant("s1", "win")?.verify_status).toBe("unverified");
    // 三次失败后 success_rate 被衰减（1 * 0.8^3）。
    expect(getSuccessRate()).toBeCloseTo(0.512, 5);
  });
});

describe("Verifier · 软性类评审（Req 7.3）", () => {
  it("reviewSoft 走注入的评审器、不执行命令；pass 缺省时按 High_Score 阈值推导", async () => {
    const reviewer: SoftSkillReviewer = {
      review: vi.fn(async () => ({ score: 0.9 })),
    };
    const connector = makeMockConnector();
    const verifier = createVerifier({ softReviewer: reviewer, connector });

    const res = await verifier.reviewSoft({ title: "t", description: "d" });
    expect(res.score).toBeCloseTo(0.9);
    expect(res.pass).toBe(true); // 0.9 >= 默认 High_Score(0.8)
    expect(reviewer.review).toHaveBeenCalledOnce();
    // 软性评审不执行命令。
    expect(connector.execCalls).toBe(0);
  });

  it("未注入评审器时 reviewSoft 抛错", async () => {
    const verifier = createVerifier({});
    await expect(verifier.reviewSoft({ title: "t", description: "d" })).rejects.toThrow();
  });
});
