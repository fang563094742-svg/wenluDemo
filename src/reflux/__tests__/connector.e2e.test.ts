/**
 * 技能反哺（Skill Reflux）· 连接器 e2e 验证测试（任务 19.2）
 * ------------------------------------------------------------------
 * 复用「模拟平台 + 真实连接器」手法：以 mock connector 充当用户本机连接器，
 * 经 Verifier 注入的 **真实 `src/verification` 引擎**（`createVerificationEngine({shellExec})`）
 * 在该连接器上跑通命令并由 **真实 `evidenceCollector`** 收集结构化证据，验证：
 *  - 可执行技能经连接器跑通 → connector-verified（且回填一期 provenance.verifiedCount）；
 *  - 服务端跑通仅 server-verified（弱证据，不充当平台可用）；
 *  - 连接器验证失败 → unverified（不误判平台可用）；
 *  - 危险命令安全预审拦截 → 不下发连接器；
 *  - connector-verified 变体连续失败 → fail_streak++ 降分，达阈值降为 unverified（降级）。
 *
 * 不连真实 PG / 真实 LLM；连接器为 mock（模拟平台 exec 应答），verification 引擎与证据收集为真实实现。
 *
 * Validates: Requirements 8.3, 8.6, 15.6
 */

import { describe, expect, it } from "vitest";

import {
  createVerifier,
  type ConnectorLike,
  type ConnectorExecResult,
  type VerifierStore,
  type DowngradeResult,
} from "../verifier.js";
import { DEFAULT_REFLUX_CONFIG } from "../config.js";
import { createEvidenceCollector } from "../../verification/index.js";
import type { VariantOS, VerifyStatus } from "../types.js";

// ─────────────────────────────────────────────────────────────────
// 模拟平台 + 真实连接器：mock connector 把 exec 交给一个「模拟平台」处理函数
// ─────────────────────────────────────────────────────────────────

/**
 * 创建一个模拟用户本机连接器：`request("exec")` 把命令交给注入的 simulatePlatform 应答，
 * 模拟「连接器把命令下发到模拟平台执行并回传退出码」。结构上满足 ConnectorLike，
 * 可被 Verifier 默认 connectorEngineFactory 包成真实 verificationEngine 的 shellExec。
 */
function makeMockConnector(
  simulatePlatform: (command: string) => ConnectorExecResult,
  info: { platform: string; machineLabel?: string } = { platform: "win", machineLabel: "user-pc" },
): ConnectorLike & { execCommands: string[] } {
  const c = {
    execCommands: [] as string[],
    async request<T>(_op: "exec", args: Record<string, unknown>): Promise<T> {
      const command = String(args.command ?? "");
      c.execCommands.push(command);
      return simulatePlatform(command) as unknown as T;
    },
    isOnline: () => true,
    activeInfo: () => info,
  };
  return c;
}

// ── 内存 VerifierStore（记录变体状态 / 回填 / 降级） ──
interface MemVariant { verify_status: VerifyStatus; verified_by?: string; fail_streak: number }
function makeMemStore() {
  const variants = new Map<string, MemVariant>();
  let verifiedCount = 0;
  let successRate = 1.0;
  const key = (s: string, os: VariantOS) => `${s}:${os}`;
  const ensure = (k: string): MemVariant => {
    let v = variants.get(k);
    if (!v) { v = { verify_status: "unverified", fail_streak: 0 }; variants.set(k, v); }
    return v;
  };
  const store: VerifierStore = {
    async markServerVerified(skillId, os) {
      const v = ensure(key(skillId, os));
      if (v.verify_status !== "connector-verified") v.verify_status = "server-verified";
    },
    async markConnectorVerified(skillId, os, verifiedBy) {
      const v = ensure(key(skillId, os));
      v.verify_status = "connector-verified"; v.verified_by = verifiedBy; v.fail_streak = 0;
      verifiedCount += 1;
    },
    async recordVariantFailure(skillId, os, downgradeStreak): Promise<DowngradeResult> {
      const v = ensure(key(skillId, os));
      v.fail_streak += 1;
      successRate = Math.max(0, successRate * 0.8);
      const downgraded = v.fail_streak >= downgradeStreak;
      if (downgraded) { v.verify_status = "unverified"; v.verified_by = undefined; }
      return { failStreak: v.fail_streak, downgraded };
    },
  };
  return {
    store,
    getVariant: (s: string, os: VariantOS) => variants.get(key(s, os)),
    getVerifiedCount: () => verifiedCount,
    getSuccessRate: () => successRate,
  };
}

// 模拟平台：除危险命令外，约定命令含 "fail" 返回非零退出码，其余成功。
const simulate = (command: string): ConnectorExecResult => {
  if (/fail/i.test(command)) return { ok: false, stdout: "", stderr: "boom", code: 1 };
  return { ok: true, stdout: "ok\n", code: 0 };
};

describe("连接器 e2e · connector-verified（真实 verification 引擎 + 真实证据收集，Req 8.3/15.6）", () => {
  it("经 mock 连接器跑通 → connector-verified，回填 provenance.verifiedCount，并收集结构化证据", async () => {
    const connector = makeMockConnector(simulate);
    const mem = makeMemStore();
    const evidence = createEvidenceCollector();
    const verifier = createVerifier({ connector, store: mem.store, evidence });

    const res = await verifier.verifyExecutable({
      skillId: "skill-1",
      command: "node --version",
      os: "win",
      viaConnector: true,
    });

    expect(res.status).toBe("connector-verified");
    expect(res.passed).toBe(true);
    expect(res.verifiedBy).toBe("user-pc");
    expect(res.safetyBlocked).toBe(false);
    // 命令确实下发到（模拟平台）连接器执行。
    expect(connector.execCommands).toContain("node --version");
    // 真实 verificationEngine 产出结构化证据，evidenceCollector 已归档。
    expect(res.evidence?.overallVerdict).toBe("passed");
    expect(evidence.size()).toBeGreaterThan(0);
    // 变体标 connector-verified，凡 connector-verified 即回填一期 verified。
    expect(mem.getVariant("skill-1", "win")?.verify_status).toBe("connector-verified");
    expect(mem.getVerifiedCount()).toBe(1);
  });

  it("服务端跑通仅 server-verified（弱证据，不回填 verifiedCount，不充当平台可用，Req 8.1）", async () => {
    // viaConnector=false：走真实服务端 verificationEngine（默认 serverEngine），跑一条恒成功命令。
    const mem = makeMemStore();
    const verifier = createVerifier({ store: mem.store });
    const res = await verifier.verifyExecutable({
      skillId: "skill-1",
      // 跨平台稳定的恒成功命令（退出码 0），不触达任何危险模式。
      command: process.platform === "win32" ? "cd ." : "true",
      os: "linux",
      viaConnector: false,
    });
    expect(res.status).toBe("server-verified");
    expect(res.passed).toBe(true);
    expect(mem.getVariant("skill-1", "linux")?.verify_status).toBe("server-verified");
    // server-verified 不满足一期 verified，不回填。
    expect(mem.getVerifiedCount()).toBe(0);
  });

  it("连接器验证失败 → unverified（不误判平台可用）", async () => {
    const connector = makeMockConnector(simulate);
    const mem = makeMemStore();
    const verifier = createVerifier({ connector, store: mem.store });
    const res = await verifier.verifyExecutable({
      skillId: "skill-1",
      command: "do-fail-thing",
      os: "win",
      viaConnector: true,
    });
    expect(res.status).toBe("unverified");
    expect(res.passed).toBe(false);
    // 未标记任何 connector-verified 变体。
    expect(mem.getVariant("skill-1", "win")?.verify_status).not.toBe("connector-verified");
    expect(mem.getVerifiedCount()).toBe(0);
  });

  it("危险命令安全预审拦截 → 不下发连接器、不验证", async () => {
    const connector = makeMockConnector(simulate);
    const mem = makeMemStore();
    const verifier = createVerifier({ connector, store: mem.store });
    const res = await verifier.verifyExecutable({
      skillId: "skill-1",
      command: "sudo rm -rf /",
      os: "linux",
      viaConnector: true,
    });
    expect(res.safetyBlocked).toBe(true);
    expect(res.passed).toBe(false);
    expect(res.status).toBe("unverified");
    // 安全预审在下发前拦截：连接器未收到任何命令。
    expect(connector.execCommands).toHaveLength(0);
  });
});

describe("连接器 e2e · 失败降级（Req 8.6）", () => {
  it("connector-verified 变体连续失败 → fail_streak++ 降分；达 Connector_Downgrade_Streak 降为 unverified", async () => {
    const mem = makeMemStore();
    // 先把变体标为 connector-verified，再制造连续执行失败。
    await mem.store.markConnectorVerified("skill-1", "win", "user-pc");
    const verifier = createVerifier({
      store: mem.store,
      config: { ...DEFAULT_REFLUX_CONFIG, Connector_Downgrade_Streak: 3 },
    });

    const r1 = await verifier.downgradeOnFailure("skill-1", "win");
    expect(r1.failStreak).toBe(1);
    expect(r1.downgraded).toBe(false);
    expect(mem.getVariant("skill-1", "win")?.verify_status).toBe("connector-verified");

    await verifier.downgradeOnFailure("skill-1", "win");
    const r3 = await verifier.downgradeOnFailure("skill-1", "win");
    expect(r3.failStreak).toBe(3);
    expect(r3.downgraded).toBe(true);
    // 达阈值降为 unverified（平台可用性回退）。
    expect(mem.getVariant("skill-1", "win")?.verify_status).toBe("unverified");
    // 连续失败按衰减因子降分（1 * 0.8^3）。
    expect(mem.getSuccessRate()).toBeCloseTo(0.512, 5);
  });
});
