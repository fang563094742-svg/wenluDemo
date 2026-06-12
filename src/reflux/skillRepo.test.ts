/**
 * SkillRepo 内存实现单元测试（不连真实 PG）。
 *
 * 覆盖基本路径：submit（写候选）/ get / list / promote（候选物化为 active 技能）/
 * merge（候选去重合并进既有技能，刷新跨用户广度）/ search / recordUsage / setStatus。
 * 内存实现与 PG 实现同契约，这里以纯逻辑验证数据访问层语义。
 *
 * _Requirements: 1.3, 11.3, 12.1_
 */

import { describe, expect, it } from "vitest";

import { createInMemorySkillRepo, type SkillSubmitInput, type SkillDraft } from "./skillRepo.js";

/** 构造一个可执行技能草稿（带一个 win 变体）。 */
function execDraft(over: Partial<SkillDraft> = {}): SkillDraft {
  return {
    kind: "executable",
    title: "压缩文件夹为 zip",
    description: "将指定目录压缩为 zip 包",
    applicable_scenario: "需要打包目录分发时",
    exec_vars: ["dir", "out"],
    exec_steps: [{ op: "exec", args: { command: "zip -r ${out} ${dir}" } } as never],
    taxonomy: { taskType: "file-ops" } as never,
    category: "file",
    tags: ["zip", "compress"],
    platform: ["win"],
    os_scope: "variant",
    source: "self_learned",
    user_neutral: true,
    variants: [{ os: "win", command: "Compress-Archive ${dir} ${out}" }],
    ...over,
  };
}

function submitInput(draft: SkillDraft, contributorId?: string): SkillSubmitInput {
  return {
    draft,
    source_role: "executable_seed",
    source_weight: "user_task",
    contributor_id: contributorId,
  };
}

describe("SkillRepo（内存实现）", () => {
  it("submit 写候选（seeded），getCandidate 可读回", async () => {
    const repo = createInMemorySkillRepo();
    const cand = await repo.submit(submitInput(execDraft(), "user-a"));

    expect(cand.id).toBeTruthy();
    expect(cand.status).toBe("seeded");
    expect(cand.kind).toBe("executable");
    expect(cand.contributor_id).toBe("user-a");

    const got = await repo.getCandidate(cand.id);
    expect(got).not.toBeNull();
    expect(got!.id).toBe(cand.id);
    // draft 完整存入候选。
    expect((got!.draft as unknown as SkillDraft).title).toBe("压缩文件夹为 zip");
  });

  it("promote 把候选物化为 active 公共技能，get 含变体与首个贡献者广度", async () => {
    const repo = createInMemorySkillRepo();
    const cand = await repo.submit(submitInput(execDraft(), "user-a"));
    const skill = await repo.promote(cand.id);

    expect(skill.status).toBe("active");
    expect(skill.version).toBe(1);
    expect(skill.kind).toBe("executable");
    expect(skill.platform).toEqual(["win"]);
    expect(skill.variants).toHaveLength(1);
    expect(skill.variants![0]).toMatchObject({ os: "win", verify_status: "unverified" });
    // 初始化质量分与 provenance（同一事实两视图）。
    expect(skill.quality).toMatchObject({ use_count: 0, success_count: 0, success_rate: 0 });
    expect(skill.provenance.totalCount).toBe(0);
    // 首个贡献者计入跨用户广度。
    expect(skill.cross_user_breadth).toBe(1);

    const got = await repo.get(skill.id);
    expect(got).not.toBeNull();
    expect(got!.id).toBe(skill.id);

    // 候选 merged_into 指向新技能（标记已物化）。
    const candAfter = await repo.getCandidate(cand.id);
    expect(candAfter!.merged_into).toBe(skill.id);

    const contribs = await repo.contributors(skill.id);
    expect(contribs.map((c) => c.user_id)).toEqual(["user-a"]);
  });

  it("list 按 status / kind 过滤", async () => {
    const repo = createInMemorySkillRepo();
    const c1 = await repo.submit(submitInput(execDraft(), "user-a"));
    const s1 = await repo.promote(c1.id);
    const c2 = await repo.submit(
      submitInput(execDraft({ kind: "soft", os_scope: "any", platform: ["any"], variants: [] }), "user-b"),
    );
    const s2 = await repo.promote(c2.id);

    const all = await repo.list();
    expect(all).toHaveLength(2);

    const active = await repo.list({ status: "active" });
    expect(active).toHaveLength(2);

    const execOnly = await repo.list({ kind: "executable" });
    expect(execOnly.map((s) => s.id)).toEqual([s1.id]);

    const softOnly = await repo.list({ kind: "soft" });
    expect(softOnly.map((s) => s.id)).toEqual([s2.id]);
  });

  it("merge 把第二个候选并入既有技能，跨用户广度递增（PK 去重）", async () => {
    const repo = createInMemorySkillRepo();
    const c1 = await repo.submit(submitInput(execDraft(), "user-a"));
    const skill = await repo.promote(c1.id);
    expect(skill.cross_user_breadth).toBe(1);

    // 新用户的同类候选合并进既有技能 → 广度 +1。
    const c2 = await repo.submit(submitInput(execDraft(), "user-b"));
    const merged = await repo.merge(c2.id, skill.id);
    expect(merged.cross_user_breadth).toBe(2);

    // 同一用户重复贡献不重复计数（PK 去重）。
    const c3 = await repo.submit(submitInput(execDraft(), "user-b"));
    const merged2 = await repo.merge(c3.id, skill.id);
    expect(merged2.cross_user_breadth).toBe(2);

    const contribs = await repo.contributors(skill.id);
    expect(contribs.map((c) => c.user_id).sort()).toEqual(["user-a", "user-b"]);

    // 候选 merged_into 指向目标技能。
    const c2After = await repo.getCandidate(c2.id);
    expect(c2After!.merged_into).toBe(skill.id);
  });

  it("recordUsage 回写质量分与 provenance（同一事实两视图）", async () => {
    const repo = createInMemorySkillRepo();
    const cand = await repo.submit(submitInput(execDraft(), "user-a"));
    const skill = await repo.promote(cand.id);

    await repo.recordUsage(skill.id, true);
    await repo.recordUsage(skill.id, false);

    const got = await repo.get(skill.id);
    expect(got!.quality.use_count).toBe(2);
    expect(got!.quality.success_count).toBe(1);
    expect(got!.quality.success_rate).toBeCloseTo(0.5);
    expect(got!.provenance.totalCount).toBe(2);
    expect(got!.provenance.verifiedCount).toBe(1);
  });

  it("setStatus retired 单向：retired 后不可改回 active，且不再被 search 检索", async () => {
    const repo = createInMemorySkillRepo();
    const cand = await repo.submit(submitInput(execDraft({ tags: ["zip"] }), "user-a"));
    const skill = await repo.promote(cand.id);

    // active 时可被检索命中。
    const before = await repo.search({ tags: ["zip"] });
    expect(before.map((s) => s.id)).toContain(skill.id);

    await repo.setStatus(skill.id, "retired");
    const afterRetire = await repo.get(skill.id);
    expect(afterRetire!.status).toBe("retired");
    expect(afterRetire!.retired_at).toBeTruthy();

    // retired 不再被检索分发。
    const afterSearch = await repo.search({ tags: ["zip"] });
    expect(afterSearch.map((s) => s.id)).not.toContain(skill.id);

    // retired 单向：尝试改回 active 无效。
    await repo.setStatus(skill.id, "active");
    const stillRetired = await repo.get(skill.id);
    expect(stillRetired!.status).toBe("retired");
  });

  it("search 仅返回 active 的 Skill_Summary（不含 exec_steps）并按 success_rate 排序", async () => {
    const repo = createInMemorySkillRepo();
    const c1 = await repo.submit(submitInput(execDraft({ title: "low", tags: ["t"] }), "user-a"));
    const s1 = await repo.promote(c1.id);
    const c2 = await repo.submit(submitInput(execDraft({ title: "high", tags: ["t"] }), "user-b"));
    const s2 = await repo.promote(c2.id);

    // s2 成功率更高 → 排前。
    await repo.recordUsage(s2.id, true);
    await repo.recordUsage(s1.id, false);

    const res = await repo.search({ tags: ["t"] });
    expect(res.map((s) => s.id)).toEqual([s2.id, s1.id]);
    // Skill_Summary 不含 exec_steps 字段。
    expect((res[0] as unknown as Record<string, unknown>).exec_steps).toBeUndefined();
    expect(res[0].name).toBe("high");
  });
});
