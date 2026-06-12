/**
 * Dispatcher（检索分发 + 渐进加载 + 降级 + 平台过滤）单元测试。
 *
 * 全部依赖注入式 mock（fake SkillRepo + mock picker + mock renderHint + mock inheritFn +
 * mock verifier），独立可跑（不连真实 PG / 真实 LLM / 真实连接器）。覆盖任务 12 要求：
 *  - top-k + 降级（12.1/12.2）：LLM 挑选生效；失败/超时/空集 → 按 quality_score 降序确定性 top-k。
 *  - 仅返 active summary（12.1）：search 仅 active；返回项为摘要、不含完整执行体。
 *  - 平台过滤（12.3）：有 connector-verified 变体直发；仅意图者附 render_hint + 标「未在你平台验证」；
 *    soft 技能平台无关直发。
 *  - inherit 骨架：复用注入的 inheritFn（幂等），结果映射正确。
 *  - settleRenderedVariant 闭环：连接器验证通过才沉淀、失败/被拦截不沉淀。
 *
 * _Requirements: 11.1, 11.2, 11.4, 11.7, 11.8, 15.5, 15.6, 15.7, 15.9, 15.10, 15.11, 15.12, 15.13_
 */

import { describe, expect, it, vi } from "vitest";

import {
  createDispatcher,
  type RenderHintProvider,
  type TopKPicker,
  type InheritFn,
} from "../dispatcher.js";
import type { SkillRepo, SkillSearchQuery } from "../skillRepo.js";
import type {
  Skill,
  SkillKind,
  OSScope,
  PlatformVariant,
  VariantOS,
  VerifyStatus,
  SkillSummary,
} from "../types.js";
import type { Verifier, VerifyResult } from "../verifier.js";

// ── 测试夹具：构造完整 Skill ──
function makeSkill(opts: {
  id: string;
  kind: SkillKind;
  os_scope: OSScope;
  platform: Skill["platform"];
  success_rate: number;
  use_count?: number;
  variants?: Array<{ os: VariantOS; verify_status: VerifyStatus }>;
  status?: Skill["status"];
}): Skill {
  const variants: PlatformVariant[] = (opts.variants ?? []).map((v) => ({
    skill_id: opts.id,
    os: v.os,
    command: `cmd-${v.os}`,
    verify_status: v.verify_status,
    fail_streak: 0,
  }));
  return {
    id: opts.id,
    kind: opts.kind,
    title: `技能 ${opts.id}`,
    description: `描述 ${opts.id}`,
    applicable_scenario: `场景 ${opts.id}`,
    exec_vars: [],
    exec_steps: [{ op: "run", args: { a1: "${var}" } }],
    taxonomy: { taskType: "generic" },
    category: "general",
    tags: ["t1"],
    platform: opts.platform,
    os_scope: opts.os_scope,
    source: "self_learned",
    user_neutral: true,
    is_starter: false,
    status: opts.status ?? "active",
    version: 1,
    provenance: { createdAt: "2024-01-01T00:00:00Z", verifiedCount: 0, totalCount: opts.use_count ?? 0 },
    quality: {
      use_count: opts.use_count ?? 0,
      success_count: 0,
      success_rate: opts.success_rate,
      silent_count: 0,
    },
    cross_user_breadth: 1,
    variants,
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
  };
}

function toSummary(s: Skill): SkillSummary {
  return {
    id: s.id,
    name: s.title,
    description: s.description,
    applicable_scenario: s.applicable_scenario,
    category: s.category,
    tags: s.tags,
    quality_score: s.quality.success_rate,
    platform_variant_count: s.variants?.length ?? 0,
    platform_verified: (s.variants ?? []).some((v) => v.verify_status === "connector-verified"),
  };
}

/**
 * fake SkillRepo：仅实现 dispatcher 用到的 search / get，其余抛错。
 * search 模拟 skillRepo.search 语义：仅 active、category/tags 过滤、平台预过滤、success_rate 降序。
 */
function makeFakeRepo(skills: Skill[]): SkillRepo {
  const byId = new Map(skills.map((s) => [s.id, s]));
  const notUsed = (name: string) => () => {
    throw new Error(`fakeRepo.${name} 不应被调用`);
  };
  return {
    async search(q: SkillSearchQuery): Promise<SkillSummary[]> {
      const want = q.platform && q.platform !== "any" ? q.platform : undefined;
      const filtered = skills.filter((s) => {
        if (s.status !== "active") return false;
        if (q.category && s.category !== q.category) return false;
        if (q.tags && q.tags.length > 0 && !q.tags.some((t) => s.tags.includes(t))) return false;
        if (!want) return true;
        if (s.os_scope === "any") return true;
        if (s.platform.includes("any") || s.platform.includes(want)) return true;
        return (s.variants ?? []).some((v) => v.os === want);
      });
      filtered.sort((a, b) => b.quality.success_rate - a.quality.success_rate);
      return filtered.slice(0, Math.max(1, Math.floor(q.limit ?? 20))).map(toSummary);
    },
    async get(skillId: string): Promise<Skill | null> {
      return byId.get(skillId) ?? null;
    },
    submit: notUsed("submit") as SkillRepo["submit"],
    getCandidate: notUsed("getCandidate") as SkillRepo["getCandidate"],
    promote: notUsed("promote") as SkillRepo["promote"],
    merge: notUsed("merge") as SkillRepo["merge"],
    list: notUsed("list") as SkillRepo["list"],
    recordUsage: notUsed("recordUsage") as SkillRepo["recordUsage"],
    setStatus: notUsed("setStatus") as SkillRepo["setStatus"],
    contributors: notUsed("contributors") as SkillRepo["contributors"],
  };
}

const mockRenderHint: RenderHintProvider = {
  async get(os: VariantOS) {
    return `渲染提示[${os}]：用对应平台 shell 语法重写`;
  },
};

describe("Dispatcher.retrieve · top-k 与降级", () => {
  it("有 LLM 挑选器时按其返回的 id 子集保序返回", async () => {
    const skills = [
      makeSkill({ id: "s1", kind: "soft", os_scope: "any", platform: ["any"], success_rate: 0.3 }),
      makeSkill({ id: "s2", kind: "soft", os_scope: "any", platform: ["any"], success_rate: 0.9 }),
      makeSkill({ id: "s3", kind: "soft", os_scope: "any", platform: ["any"], success_rate: 0.5 }),
    ];
    const picker: TopKPicker = { pick: vi.fn(async () => ["s3", "s1"]) };
    const d = createDispatcher({ repo: makeFakeRepo(skills), picker, renderHint: mockRenderHint });

    const res = await d.retrieve({ userId: "u1", topK: 2 });
    expect(res.map((r) => r.summary.id)).toEqual(["s3", "s1"]);
    expect(picker.pick).toHaveBeenCalledOnce();
  });

  it("LLM 挑选抛错 → 降级为按 quality_score 降序确定性 top-k", async () => {
    const skills = [
      makeSkill({ id: "s1", kind: "soft", os_scope: "any", platform: ["any"], success_rate: 0.3 }),
      makeSkill({ id: "s2", kind: "soft", os_scope: "any", platform: ["any"], success_rate: 0.9 }),
      makeSkill({ id: "s3", kind: "soft", os_scope: "any", platform: ["any"], success_rate: 0.5 }),
    ];
    const picker: TopKPicker = {
      pick: vi.fn(async () => {
        throw new Error("LLM 挂了");
      }),
    };
    const d = createDispatcher({ repo: makeFakeRepo(skills), picker, renderHint: mockRenderHint });

    const res = await d.retrieve({ userId: "u1", topK: 2 });
    expect(res.map((r) => r.summary.id)).toEqual(["s2", "s3"]); // 0.9, 0.5
  });

  it("LLM 挑选超时 → 降级，不阻塞", async () => {
    const skills = [
      makeSkill({ id: "s1", kind: "soft", os_scope: "any", platform: ["any"], success_rate: 0.7 }),
      makeSkill({ id: "s2", kind: "soft", os_scope: "any", platform: ["any"], success_rate: 0.2 }),
    ];
    const picker: TopKPicker = {
      pick: () => new Promise<string[]>(() => {}), // 永不 resolve
    };
    const d = createDispatcher({
      repo: makeFakeRepo(skills),
      picker,
      renderHint: mockRenderHint,
      pickTimeoutMs: 20,
    });

    const res = await d.retrieve({ userId: "u1", topK: 1 });
    expect(res.map((r) => r.summary.id)).toEqual(["s1"]);
  });

  it("LLM 返回空集 → 降级确定性", async () => {
    const skills = [
      makeSkill({ id: "s1", kind: "soft", os_scope: "any", platform: ["any"], success_rate: 0.4 }),
    ];
    const picker: TopKPicker = { pick: vi.fn(async () => []) };
    const d = createDispatcher({ repo: makeFakeRepo(skills), picker, renderHint: mockRenderHint });

    const res = await d.retrieve({ userId: "u1", topK: 3 });
    expect(res.map((r) => r.summary.id)).toEqual(["s1"]);
  });

  it("无 LLM 挑选器 → 纯确定性 quality_score 降序", async () => {
    const skills = [
      makeSkill({ id: "s1", kind: "soft", os_scope: "any", platform: ["any"], success_rate: 0.1 }),
      makeSkill({ id: "s2", kind: "soft", os_scope: "any", platform: ["any"], success_rate: 0.8 }),
    ];
    const d = createDispatcher({ repo: makeFakeRepo(skills), renderHint: mockRenderHint });

    const res = await d.retrieve({ userId: "u1" });
    expect(res.map((r) => r.summary.id)).toEqual(["s2", "s1"]);
  });
});

describe("Dispatcher.retrieve · 仅返 active summary", () => {
  it("retired 技能不进检索结果，且返回项为摘要（不含完整执行体）", async () => {
    const skills = [
      makeSkill({ id: "active1", kind: "soft", os_scope: "any", platform: ["any"], success_rate: 0.6 }),
      makeSkill({
        id: "retired1",
        kind: "soft",
        os_scope: "any",
        platform: ["any"],
        success_rate: 0.99,
        status: "retired",
      }),
    ];
    const d = createDispatcher({ repo: makeFakeRepo(skills), renderHint: mockRenderHint });

    const res = await d.retrieve({ userId: "u1" });
    expect(res.map((r) => r.summary.id)).toEqual(["active1"]);
    // 摘要不含 exec_steps/script（渐进加载，Req 11.4）。
    expect((res[0].summary as unknown as Record<string, unknown>).exec_steps).toBeUndefined();
    expect(res[0].summary.name).toBe("技能 active1");
  });
});

describe("Dispatcher.retrieve · 平台过滤", () => {
  it("可执行技能在该平台有 connector-verified 变体 → 直发（verified，无渲染提示）", async () => {
    const skills = [
      makeSkill({
        id: "exe1",
        kind: "executable",
        os_scope: "variant",
        platform: ["win"],
        success_rate: 0.7,
        variants: [{ os: "win", verify_status: "connector-verified" }],
      }),
    ];
    const d = createDispatcher({ repo: makeFakeRepo(skills), renderHint: mockRenderHint });

    const res = await d.retrieve({ userId: "u1", platform: "win" });
    expect(res).toHaveLength(1);
    expect(res[0].platform_status).toBe("verified");
    expect(res[0].dispatchable).toBe(true);
    expect(res[0].unverified_on_platform).toBe(false);
    expect(res[0].render_hint).toBeUndefined();
    expect(res[0].summary.platform_verified).toBe(true);
  });

  it("可执行技能仅有平台中立意图（无该平台已验证变体）→ 附 render_hint + 标未在你平台验证", async () => {
    const renderHint: RenderHintProvider = { get: vi.fn(async (os) => `提示-${os}`) };
    const skills = [
      makeSkill({
        id: "exe2",
        kind: "executable",
        os_scope: "variant",
        platform: ["win"],
        success_rate: 0.7,
        // 仅有 server-verified（弱证据），不算该平台可用
        variants: [{ os: "win", verify_status: "server-verified" }],
      }),
    ];
    const d = createDispatcher({ repo: makeFakeRepo(skills), renderHint });

    const res = await d.retrieve({ userId: "u1", platform: "win" });
    expect(res).toHaveLength(1);
    expect(res[0].platform_status).toBe("needs_render");
    expect(res[0].unverified_on_platform).toBe(true);
    expect(res[0].render_hint).toBe("提示-win");
    expect(res[0].summary.platform_verified).toBe(false);
    expect(renderHint.get).toHaveBeenCalledWith("win");
  });

  it("soft 技能与平台无关 → platform_agnostic 直发", async () => {
    const skills = [
      makeSkill({ id: "soft1", kind: "soft", os_scope: "any", platform: ["any"], success_rate: 0.5 }),
    ];
    const d = createDispatcher({ repo: makeFakeRepo(skills), renderHint: mockRenderHint });

    const res = await d.retrieve({ userId: "u1", platform: "mac" });
    expect(res[0].platform_status).toBe("platform_agnostic");
    expect(res[0].dispatchable).toBe(true);
    expect(res[0].unverified_on_platform).toBe(false);
  });
});

describe("Dispatcher.expand", () => {
  it("复用 repo.get 展开完整技能（含 exec_steps）", async () => {
    const skills = [
      makeSkill({ id: "s1", kind: "executable", os_scope: "variant", platform: ["win"], success_rate: 0.5 }),
    ];
    const d = createDispatcher({ repo: makeFakeRepo(skills), renderHint: mockRenderHint });

    const full = await d.expand("s1", "u1");
    expect(full?.id).toBe("s1");
    expect(full?.exec_steps).toEqual([{ op: "run", args: { a1: "${var}" } }]);
    expect(await d.expand("missing", "u1")).toBeNull();
  });
});

describe("Dispatcher.inherit · 复用 inheritFn（幂等骨架）", () => {
  it("调用注入的 inheritFn 并映射结果", async () => {
    const inheritFn: InheritFn = vi.fn(async (_userId, skillIds) =>
      (skillIds ?? ["a", "b"]).map((id: string) => ({ id })),
    );
    const d = createDispatcher({
      repo: makeFakeRepo([]),
      renderHint: mockRenderHint,
      inheritFn,
    });

    const res = await d.inherit("u1", ["x", "y"]);
    expect(res.inherited).toEqual(["x", "y"]);
    expect(res.count).toBe(2);
    expect(inheritFn).toHaveBeenCalledWith("u1", ["x", "y"]);
  });
});

describe("Dispatcher.settleRenderedVariant · 重渲染闭环（接口预留）", () => {
  function makeVerifier(result: Partial<VerifyResult>): Verifier {
    return {
      verifyExecutable: vi.fn(async () => ({
        status: "connector-verified",
        passed: true,
        os: "win",
        safetyBlocked: false,
        reason: "ok",
        ...result,
      })) as Verifier["verifyExecutable"],
      reviewSoft: vi.fn() as Verifier["reviewSoft"],
      downgradeOnFailure: vi.fn() as Verifier["downgradeOnFailure"],
    };
  }

  it("连接器验证通过 → 沉淀新 connector-verified 变体", async () => {
    const persistVariant = vi.fn(async () => {});
    const d = createDispatcher({
      repo: makeFakeRepo([]),
      renderHint: mockRenderHint,
      verifier: makeVerifier({ status: "connector-verified", passed: true, verifiedBy: "user-pc" }),
      persistVariant,
    });

    const res = await d.settleRenderedVariant({ skillId: "s1", os: "win", command: "echo hi" });
    expect(res.sedimented).toBe(true);
    expect(res.status).toBe("connector-verified");
    expect(persistVariant).toHaveBeenCalledWith({
      skillId: "s1",
      os: "win",
      command: "echo hi",
      verifiedBy: "user-pc",
    });
  });

  it("连接器验证未通过 → 不沉淀", async () => {
    const persistVariant = vi.fn(async () => {});
    const d = createDispatcher({
      repo: makeFakeRepo([]),
      renderHint: mockRenderHint,
      verifier: makeVerifier({ status: "unverified", passed: false }),
      persistVariant,
    });

    const res = await d.settleRenderedVariant({ skillId: "s1", os: "win", command: "echo hi" });
    expect(res.sedimented).toBe(false);
    expect(persistVariant).not.toHaveBeenCalled();
  });

  it("安全预审拦截 → 不沉淀、不在连接器执行", async () => {
    const persistVariant = vi.fn(async () => {});
    const d = createDispatcher({
      repo: makeFakeRepo([]),
      renderHint: mockRenderHint,
      verifier: makeVerifier({ status: "unverified", passed: false, safetyBlocked: true }),
      persistVariant,
    });

    const res = await d.settleRenderedVariant({ skillId: "s1", os: "win", command: "rm -rf /" });
    expect(res.sedimented).toBe(false);
    expect(res.safetyBlocked).toBe(true);
    expect(persistVariant).not.toHaveBeenCalled();
  });
});
