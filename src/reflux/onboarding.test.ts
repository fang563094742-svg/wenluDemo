/**
 * Onboarding 冷启动继承（T1）单元测试（不连真实 PG）。
 *
 * 覆盖：
 *  - Starter 选取条件（active ∧ Cross_User_Breadth≥M ∧ User_Neutral ∧ 平台匹配；
 *    top-N 上限 + 综合排序；不以"全量 active 或仅高分"为依据）
 *  - 平台未知先发 soft（soft_done，executable 延后）
 *  - 连接器上线补继承 executable（completed）
 *  - 幂等最多一次（并发/重复返回既有结果、不重复执行）
 *  - 补继承失败 → 保持未完成，后续重试成功
 *
 * _Requirements: 17.1, 17.2, 17.3, 17.4, 17.5, 17.6, 17.7, 17.8, 17.9, 17.10, 18.5_
 */

import { describe, expect, it, vi } from "vitest";

import { DEFAULT_REFLUX_CONFIG, type RefluxConfig } from "./config.js";
import {
  createInMemoryOnboardingStore,
  createOnboarding,
  selectStarterSkills,
  type InheritFn,
} from "./onboarding.js";
import type { SkillListFilter, SkillRepo } from "./skillRepo.js";
import type { Skill, VariantOS } from "./types.js";

// ── 测试夹具 ───────────────────────────────────────────────────────────────

/** 构造一个技能（默认 soft / active / user_neutral / breadth=5）。 */
function mkSkill(over: Partial<Skill> = {}): Skill {
  return {
    id: "s",
    kind: "soft",
    title: "t",
    description: "d",
    exec_vars: [],
    exec_steps: [],
    taxonomy: { taskType: "generic" } as never,
    category: "general",
    tags: [],
    platform: ["any"],
    os_scope: "any",
    source: "self_learned",
    user_neutral: true,
    is_starter: false,
    status: "active",
    version: 1,
    provenance: { createdAt: "", verifiedCount: 0, totalCount: 0 },
    quality: { use_count: 0, success_count: 0, success_rate: 0, silent_count: 0 },
    cross_user_breadth: 5,
    variants: [],
    created_at: "",
    updated_at: "",
    ...over,
  };
}

/** 构造一个带某平台 connector-verified 变体的 executable 技能。 */
function mkExec(id: string, os: VariantOS, verified: boolean, over: Partial<Skill> = {}): Skill {
  return mkSkill({
    id,
    kind: "executable",
    os_scope: "variant",
    platform: [os],
    variants: [
      {
        skill_id: id,
        os,
        command: "cmd ${x}",
        verify_status: verified ? "connector-verified" : "server-verified",
        fail_streak: 0,
      },
    ],
    ...over,
  });
}

/** 最小 SkillRepo 桩：仅实现 onboarding 用到的 `list`。 */
function stubRepo(skills: Skill[]): SkillRepo {
  return {
    async list(filter: SkillListFilter = {}): Promise<Skill[]> {
      return skills.filter((s) => (filter.status ? s.status === filter.status : true));
    },
  } as unknown as SkillRepo;
}

/**
 * 幂等 inheritFn 桩：按 ids 过滤 active 技能继承，结果并集写入 store（便于 listInheritedSkillIds）。
 * 与 capability-pool.inheritSkills 行为一致（同 (user, skill) 只继承一次）。
 */
function makeInheritFn(
  skills: Skill[],
  store: ReturnType<typeof createInMemoryOnboardingStore>,
): InheritFn {
  const byUser = new Map<string, Set<string>>();
  return async (userId: string, skillIds?: string[]) => {
    const active = skills.filter((s) => s.status === "active");
    const wanted = skillIds ? new Set(skillIds) : null;
    const matched = active.filter((s) => !wanted || wanted.has(s.id));
    const set = byUser.get(userId) ?? new Set<string>();
    for (const s of matched) set.add(s.id);
    byUser.set(userId, set);
    store.__setInherited(userId, [...set]);
    return matched.map((s) => ({ id: s.id }));
  };
}

const cfg: RefluxConfig = { ...DEFAULT_REFLUX_CONFIG, Starter_M: 3, Starter_TopN: 20 };

// ── selectStarterSkills 纯函数：选取条件 ──────────────────────────────────────

describe("selectStarterSkills（Starter 选取条件）", () => {
  it("仅纳入 active ∧ breadth≥M ∧ user_neutral ∧ 平台匹配；排除其余（Req 17.2/18.5）", () => {
    const skills: Skill[] = [
      mkSkill({ id: "soft-ok", cross_user_breadth: 5 }), // soft 合格
      mkSkill({ id: "retired", status: "retired", cross_user_breadth: 9 }), // 非 active 排除
      mkSkill({ id: "low-breadth", cross_user_breadth: 2 }), // breadth<M 排除
      mkSkill({ id: "not-neutral", user_neutral: false, cross_user_breadth: 9 }), // 非中立排除(18.5)
      mkExec("exe-win-verified", "win", true), // executable + win connector-verified 合格
      mkExec("exe-win-unverified", "win", false), // executable 但无 connector-verified 排除
      mkExec("exe-mac-verified", "mac", true), // 平台不匹配(win 请求)排除
    ];
    const picked = selectStarterSkills(skills, "win", cfg, true).map((s) => s.id);
    expect(picked).toContain("soft-ok");
    expect(picked).toContain("exe-win-verified");
    expect(picked).not.toContain("retired");
    expect(picked).not.toContain("low-breadth");
    expect(picked).not.toContain("not-neutral");
    expect(picked).not.toContain("exe-win-unverified");
    expect(picked).not.toContain("exe-mac-verified");
  });

  it("平台未知（includeExecutable=false）仅纳入 soft，executable 一律延后（Req 17.5）", () => {
    const skills: Skill[] = [
      mkSkill({ id: "soft-ok", cross_user_breadth: 5 }),
      mkExec("exe-win-verified", "win", true),
    ];
    const picked = selectStarterSkills(skills, undefined, cfg, false).map((s) => s.id);
    expect(picked).toEqual(["soft-ok"]);
  });

  it("不以'仅高分'为依据：高质量低广度被排除、低质量达广度被纳入（Req 17.3）", () => {
    const skills: Skill[] = [
      mkSkill({
        id: "high-score-low-breadth",
        cross_user_breadth: 1,
        quality: { use_count: 100, success_count: 99, success_rate: 0.99, silent_count: 0 },
      }),
      mkSkill({
        id: "low-score-enough-breadth",
        cross_user_breadth: 4,
        quality: { use_count: 10, success_count: 3, success_rate: 0.3, silent_count: 0 },
      }),
    ];
    const picked = selectStarterSkills(skills, "win", cfg, true).map((s) => s.id);
    expect(picked).toEqual(["low-score-enough-breadth"]);
  });

  it("top-N 上限 + 综合排序（广度为主、质量分细分，Req 17.4）", () => {
    const skills: Skill[] = [
      mkSkill({ id: "a", cross_user_breadth: 5, quality: { use_count: 1, success_count: 1, success_rate: 0.5, silent_count: 0 } }),
      mkSkill({ id: "b", cross_user_breadth: 8, quality: { use_count: 1, success_count: 1, success_rate: 0.2, silent_count: 0 } }),
      mkSkill({ id: "c", cross_user_breadth: 8, quality: { use_count: 1, success_count: 1, success_rate: 0.9, silent_count: 0 } }),
    ];
    const picked = selectStarterSkills(skills, "win", { ...cfg, Starter_TopN: 2 }, true).map((s) => s.id);
    // 广度 8 的 c/b 排在广度 5 的 a 前；同广度内 c(0.9) > b(0.2)；top-2 取 [c, b]。
    expect(picked).toEqual(["c", "b"]);
  });
});

// ── onboard / topUpOnConnector ────────────────────────────────────────────

describe("onboard（冷启动继承）", () => {
  it("平台未知先发 soft → soft_done，executable 不继承（Req 17.5）", async () => {
    const skills = [mkSkill({ id: "soft-ok" }), mkExec("exe-win", "win", true)];
    const store = createInMemoryOnboardingStore();
    const onboarding = createOnboarding({
      repo: stubRepo(skills),
      store,
      inheritFn: makeInheritFn(skills, store),
      config: cfg,
    });

    const res = await onboarding.onboard("user-a"); // 平台未知
    expect(res.status).toBe("soft_done");
    expect(res.inherited).toEqual(["soft-ok"]);
    expect(res.starterSkillIds).toEqual(["soft-ok"]);
    expect(res.alreadyOnboarded).toBe(false);
  });

  it("平台已知 → 选 soft + 匹配平台 executable → completed（Req 17.2）", async () => {
    const skills = [mkSkill({ id: "soft-ok" }), mkExec("exe-win", "win", true), mkExec("exe-mac", "mac", true)];
    const store = createInMemoryOnboardingStore();
    const onboarding = createOnboarding({
      repo: stubRepo(skills),
      store,
      inheritFn: makeInheritFn(skills, store),
      config: cfg,
    });

    const res = await onboarding.onboard("user-b", "win");
    expect(res.status).toBe("completed");
    expect(res.platform).toBe("win");
    expect(new Set(res.inherited)).toEqual(new Set(["soft-ok", "exe-win"]));
    expect(res.inherited).not.toContain("exe-mac");
  });

  it("同一用户最多一次：重复触发返回既有结果、不重复执行（Req 17.9）", async () => {
    const skills = [mkSkill({ id: "soft-ok" })];
    const store = createInMemoryOnboardingStore();
    const inheritFn = vi.fn(makeInheritFn(skills, store));
    const onboarding = createOnboarding({ repo: stubRepo(skills), store, inheritFn, config: cfg });

    const first = await onboarding.onboard("user-c");
    expect(first.alreadyOnboarded).toBe(false);
    expect(inheritFn).toHaveBeenCalledTimes(1);

    const second = await onboarding.onboard("user-c");
    expect(second.alreadyOnboarded).toBe(true);
    expect(second.starterSkillIds).toEqual([]); // 未重新选取
    expect(second.inherited).toEqual(["soft-ok"]); // 返回既有继承结果
    expect(inheritFn).toHaveBeenCalledTimes(1); // 未再次继承
  });

  it("并发首登：第二个请求命中既有行直接返回（Req 17.9）", async () => {
    const skills = [mkSkill({ id: "soft-ok" })];
    const store = createInMemoryOnboardingStore();
    const inheritFn = vi.fn(makeInheritFn(skills, store));
    const onboarding = createOnboarding({ repo: stubRepo(skills), store, inheritFn, config: cfg });

    // 串行模拟并发：内存 store 的 ensurePending 在第二次返回 created=false。
    const [r1, r2] = [await onboarding.onboard("user-d"), await onboarding.onboard("user-d")];
    const fresh = [r1, r2].filter((r) => !r.alreadyOnboarded);
    const reused = [r1, r2].filter((r) => r.alreadyOnboarded);
    expect(fresh).toHaveLength(1);
    expect(reused).toHaveLength(1);
    expect(inheritFn).toHaveBeenCalledTimes(1);
  });
});

describe("topUpOnConnector（连接器上线补继承）", () => {
  it("soft_done 后上报平台 → 补继承匹配平台 executable → completed（Req 17.6）", async () => {
    const skills = [mkSkill({ id: "soft-ok" }), mkExec("exe-win", "win", true)];
    const store = createInMemoryOnboardingStore();
    const onboarding = createOnboarding({
      repo: stubRepo(skills),
      store,
      inheritFn: makeInheritFn(skills, store),
      config: cfg,
    });

    const ob = await onboarding.onboard("user-e"); // 平台未知 → soft_done
    expect(ob.status).toBe("soft_done");

    const top = await onboarding.topUpOnConnector("user-e", "win");
    expect(top.completed).toBe(true);
    expect(top.status).toBe("completed");
    expect(top.inherited).toContain("exe-win");

    const ids = await store.listInheritedSkillIds("user-e");
    expect(new Set(ids)).toEqual(new Set(["soft-ok", "exe-win"]));
  });

  it("已 completed → 幂等跳过", async () => {
    const skills = [mkSkill({ id: "soft-ok" }), mkExec("exe-win", "win", true)];
    const store = createInMemoryOnboardingStore();
    const inheritFn = vi.fn(makeInheritFn(skills, store));
    const onboarding = createOnboarding({ repo: stubRepo(skills), store, inheritFn, config: cfg });

    await onboarding.onboard("user-f", "win"); // 直接 completed
    inheritFn.mockClear();
    const top = await onboarding.topUpOnConnector("user-f", "win");
    expect(top.completed).toBe(true);
    expect(inheritFn).not.toHaveBeenCalled(); // 已完成不再继承
  });

  it("补继承失败 → 保持未完成，后续重试成功（Req 17.7）", async () => {
    const skills = [mkSkill({ id: "soft-ok" }), mkExec("exe-win", "win", true)];
    const store = createInMemoryOnboardingStore();
    const okInherit = makeInheritFn(skills, store);
    let failOnce = true;
    const inheritFn: InheritFn = async (userId, ids) => {
      // 软技能继承（onboard 阶段）放行；executable 补继承第一次抛错。
      if (failOnce && ids && ids.includes("exe-win")) {
        failOnce = false;
        throw new Error("连接器补继承失败（模拟）");
      }
      return okInherit(userId, ids);
    };
    const onboarding = createOnboarding({ repo: stubRepo(skills), store, inheritFn, config: cfg });

    await onboarding.onboard("user-g"); // soft_done
    await expect(onboarding.topUpOnConnector("user-g", "win")).rejects.toThrow();
    // 失败后状态仍未完成。
    const mid = await store.getState("user-g");
    expect(mid?.status).toBe("soft_done");

    // 后续重试成功 → completed。
    const retry = await onboarding.topUpOnConnector("user-g", "win");
    expect(retry.completed).toBe(true);
    const done = await store.getState("user-g");
    expect(done?.status).toBe("completed");
  });
});
