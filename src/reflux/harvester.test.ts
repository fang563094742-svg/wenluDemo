/**
 * Harvester 单元测试（任务 10：采集，零 LLM / Req 2 + 16.1/16.2 + 3.1/3.3/3.4 + 20.2）
 * ------------------------------------------------------------------
 * 用注入式 mock `query` + mock `trajectoryBuffer` 模拟 PG，独立可跑（不连真实数据库）：
 *  - 入队映射：truth_gate / executable_seed / soft_seed 信号正确写 skill_harvest_queue；
 *    onVerifyPassed 带 linked_verifiable_id、onPredictionSettled hit 带 linked_prediction_id、miss 不入队；
 *  - Entry_Gate 隐私闸：来自 understand_user/userModel/个人 beliefs 的信号被丢弃、不入队；
 *  - 零 LLM：采集路径无任何 LLM provider 调用，副作用仅为 DB 写 / 轨迹写；
 *  - 调用事件记录：recordInvocation 写 skill_invocation_event（反向点亮 + 静默检测原料）；
 *  - 鲁棒性：query/轨迹写抛错时被吞掉、不向上抛（不破坏主链，A4）。
 *
 * Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 16.1, 16.2, 3.1, 3.3, 3.4, 20.2
 */
import { describe, it, expect, vi } from "vitest";

import {
  createHarvester,
  isPrivacySignal,
  SYSTEM_USER_LOCAL,
  type HarvestContext,
  type HarvestQueryFn,
} from "./harvester.js";
import type { HarvestSignal, TrajectoryEvent } from "./types.js";
import type { TrajectoryBuffer } from "./trajectoryBuffer.js";

// ── 测试夹具：捕获 SQL 的 mock query ──

interface Call {
  sql: string;
  params: unknown[];
}

function makeMemQuery(opts: { fail?: boolean } = {}) {
  const calls: Call[] = [];
  const query: HarvestQueryFn = async (text, params = []) => {
    if (opts.fail) throw new Error("模拟 DB 故障");
    calls.push({ sql: text.replace(/\s+/g, " ").trim(), params });
    return { rows: [] };
  };
  return { calls, query };
}

// ── 测试夹具：mock 轨迹缓冲（只记录 recordAction 调用） ──

function makeMemTrajectory(opts: { fail?: boolean } = {}) {
  const actions: TrajectoryEvent[] = [];
  const trajectory: TrajectoryBuffer = {
    async recordAction(ev) {
      if (opts.fail) throw new Error("模拟轨迹写故障");
      actions.push(ev);
    },
    async getRecent() {
      return [];
    },
    async pruneTrajectory() {
      return 0;
    },
  };
  return { actions, trajectory };
}

const ctx: HarvestContext = { contributor_id: SYSTEM_USER_LOCAL, source_weight: "user_task" };

/** 取所有写 skill_harvest_queue 的调用。 */
const harvestInserts = (calls: Call[]) =>
  calls.filter((c) => /INSERT INTO skill_harvest_queue/i.test(c.sql));
/** 取所有写 skill_invocation_event 的调用。 */
const invocationInserts = (calls: Call[]) =>
  calls.filter((c) => /INSERT INTO skill_invocation_event/i.test(c.sql));

describe("Harvester · 入队映射（Req 2.1–2.5/2.8）", () => {
  it("enqueue 把 executable_seed/soft_seed/truth_gate 信号写入 skill_harvest_queue", async () => {
    const q = makeMemQuery();
    const h = createHarvester({ query: q.query, trajectory: makeMemTrajectory().trajectory });

    const sig: HarvestSignal = {
      signal_role: "executable_seed",
      source_tool: "forge_capability",
      source_weight: "user_task",
      contributor_id: SYSTEM_USER_LOCAL,
      payload: { command: "echo hi" },
      linked_prediction_id: "pred-1",
      task_id: "task-1",
    };
    const ok = await h.enqueue(sig);

    expect(ok).toBe(true);
    const ins = harvestInserts(q.calls);
    expect(ins).toHaveLength(1);
    // 参数顺序：signal_role, source_tool, source_weight, contributor_id, payload(JSON),
    //           linked_prediction_id, linked_verifiable_id, task_id
    expect(ins[0].params[0]).toBe("executable_seed");
    expect(ins[0].params[1]).toBe("forge_capability");
    expect(ins[0].params[2]).toBe("user_task");
    expect(ins[0].params[3]).toBe(SYSTEM_USER_LOCAL);
    expect(ins[0].params[5]).toBe("pred-1"); // linked_prediction_id
    expect(ins[0].params[7]).toBe("task-1"); // task_id
  });

  it("onVerifyPassed 入队 truth_gate 且带 linked_verifiable_id（可验证任务关联，任务 10.2）", async () => {
    const q = makeMemQuery();
    const h = createHarvester({ query: q.query, trajectory: makeMemTrajectory().trajectory });

    await h.onVerifyPassed("verifiable-9", "证据片段", { task_id: "task-9" }, ctx);

    const ins = harvestInserts(q.calls);
    expect(ins).toHaveLength(1);
    expect(ins[0].params[0]).toBe("truth_gate");
    expect(ins[0].params[1]).toBe("verify_task");
    expect(ins[0].params[6]).toBe("verifiable-9"); // linked_verifiable_id
    expect(ins[0].params[7]).toBe("task-9"); // task_id 取自轨迹引用
  });

  it("onPredictionSettled hit 入队 truth_gate 带 linked_prediction_id；miss 不入队（Req 2.6 同理）", async () => {
    const q = makeMemQuery();
    const h = createHarvester({ query: q.query, trajectory: makeMemTrajectory().trajectory });

    await h.onPredictionSettled("pred-7", "hit", "命中结果", { ...ctx, task_id: "task-7" });
    await h.onPredictionSettled("pred-8", "miss", "落空结果", ctx);

    const ins = harvestInserts(q.calls);
    expect(ins).toHaveLength(1); // 仅 hit 入队
    expect(ins[0].params[0]).toBe("truth_gate");
    expect(ins[0].params[1]).toBe("settle_prediction");
    expect(ins[0].params[5]).toBe("pred-7"); // linked_prediction_id
  });

  it("enqueue 拒绝缺失 source_weight / 非法 signal_role 的信号（Entry_Gate a/d）", async () => {
    const q = makeMemQuery();
    const h = createHarvester({ query: q.query, trajectory: makeMemTrajectory().trajectory, onError: () => {} });

    const bad1 = await h.enqueue({
      signal_role: "soft_seed",
      source_tool: "add_rule",
      // @ts-expect-error 故意制造非法 source_weight 以验证拒绝
      source_weight: "",
      contributor_id: SYSTEM_USER_LOCAL,
      payload: {},
    });
    const bad2 = await h.enqueue({
      // @ts-expect-error 故意制造非法 signal_role 以验证拒绝
      signal_role: "garbage",
      source_tool: "add_rule",
      source_weight: "user_task",
      contributor_id: SYSTEM_USER_LOCAL,
      payload: {},
    });

    expect(bad1).toBe(false);
    expect(bad2).toBe(false);
    expect(harvestInserts(q.calls)).toHaveLength(0);
  });
});

describe("Harvester · Entry_Gate 隐私闸丢弃（Req 2.7 / 16.1）", () => {
  it("来自 understand_user / userModel / 个人 beliefs 的信号被丢弃、不入队", async () => {
    const q = makeMemQuery();
    const h = createHarvester({ query: q.query, trajectory: makeMemTrajectory().trajectory, onError: () => {} });

    const privacySources: HarvestSignal[] = [
      { signal_role: "soft_seed", source_tool: "understand_user", source_weight: "user_task", contributor_id: SYSTEM_USER_LOCAL, payload: {} },
      { signal_role: "soft_seed", source_tool: "userModel", source_weight: "user_task", contributor_id: SYSTEM_USER_LOCAL, payload: {} },
      { signal_role: "soft_seed", source_tool: "add_belief", source_weight: "user_task", contributor_id: SYSTEM_USER_LOCAL, payload: {} },
      // 来源工具看似中立，但 payload 键暴露对主人的理解 → 同样丢弃
      { signal_role: "soft_seed", source_tool: "consolidate", source_weight: "user_task", contributor_id: SYSTEM_USER_LOCAL, payload: { owner_belief: "主人喜欢深色主题" } },
    ];
    for (const sig of privacySources) {
      expect(isPrivacySignal(sig)).toBe(true);
      expect(await h.enqueue(sig)).toBe(false);
    }
    expect(harvestInserts(q.calls)).toHaveLength(0);
  });

  it("可泛化的中立信号（add_rule / master_tool）不被隐私闸误伤", async () => {
    const q = makeMemQuery();
    const h = createHarvester({ query: q.query, trajectory: makeMemTrajectory().trajectory });

    const neutral: HarvestSignal[] = [
      { signal_role: "soft_seed", source_tool: "add_rule", source_weight: "autonomous", contributor_id: SYSTEM_USER_LOCAL, payload: { rule: "提交前先跑测试" } },
      { signal_role: "executable_seed", source_tool: "master_tool", source_weight: "user_task", contributor_id: SYSTEM_USER_LOCAL, payload: { command: "git status" } },
    ];
    for (const sig of neutral) {
      expect(isPrivacySignal(sig)).toBe(false);
      expect(await h.enqueue(sig)).toBe(true);
    }
    expect(harvestInserts(q.calls)).toHaveLength(2);
  });
});

describe("Harvester · 零 LLM 且不阻塞主链（Req 20.2 / A4）", () => {
  it("采集全路径仅产生 DB 写 / 轨迹写，无任何 LLM provider 介入", async () => {
    const q = makeMemQuery();
    const t = makeMemTrajectory();
    const h = createHarvester({ query: q.query, trajectory: t.trajectory });

    // 跑通所有采集入口。
    await h.enqueue({ signal_role: "soft_seed", source_tool: "add_rule", source_weight: "user_task", contributor_id: SYSTEM_USER_LOCAL, payload: {} });
    await h.onVerifyPassed("v1", "e", { task_id: "t1" }, ctx);
    await h.onPredictionSettled("p1", "hit", "o", ctx);
    await h.stashTrajectory("t2", [{ action_name: "run_command", args_summary: "ls" }], "目标", "完成", ctx);
    await h.recordAction({ user_id: SYSTEM_USER_LOCAL, action_name: "read_file" });
    await h.recordInvocation({ user_id: SYSTEM_USER_LOCAL, command_fingerprint: "fp1", outcome: "success" });

    // 副作用只有：写 skill_harvest_queue / skill_invocation_event（query），写 trajectory_event（trajectory）。
    // mock query 只接受这些 SQL；若采集路径试图做别的事（如 LLM 调用）测试夹具里根本无此能力。
    expect(q.calls.every((c) => /INSERT INTO (skill_harvest_queue|skill_invocation_event)/i.test(c.sql))).toBe(true);
    expect(t.actions.length).toBeGreaterThan(0);
  });

  it("finish_task done 仅落轨迹、不入队为成功信号（Req 2.6）；任务线用 cur.id 关联（任务 10.2）", async () => {
    const q = makeMemQuery();
    const t = makeMemTrajectory();
    const h = createHarvester({ query: q.query, trajectory: t.trajectory });

    await h.stashTrajectory(
      "task-done-1",
      [
        { action_name: "run_command", args_summary: "npm test", result_summary: "passed", cycle: 3 },
        { action_name: "read_file", args_summary: "a.ts" },
      ],
      "跑通测试",
      "done",
      ctx,
    );

    // 不入队任何成功信号。
    expect(harvestInserts(q.calls)).toHaveLength(0);
    // 轨迹按 task_id=cur.id 关联（含 2 条 log + 1 条收尾摘要）。
    expect(t.actions).toHaveLength(3);
    expect(t.actions.every((a) => a.task_id === "task-done-1")).toBe(true);
    expect(t.actions.every((a) => a.user_id === SYSTEM_USER_LOCAL)).toBe(true);
    expect(t.actions[2].action_name).toBe("finish_task"); // 收尾摘要
  });
});

describe("Harvester · 调用事件记录（Req 2.9）", () => {
  it("recordInvocation 写 skill_invocation_event，参数完整", async () => {
    const q = makeMemQuery();
    const h = createHarvester({ query: q.query, trajectory: makeMemTrajectory().trajectory });

    await h.recordInvocation({
      user_id: SYSTEM_USER_LOCAL,
      candidate_id: "cand-3",
      command_fingerprint: "git:status",
      task_id: "task-3",
      platform: "win",
      outcome: "success",
    });

    const ins = invocationInserts(q.calls);
    expect(ins).toHaveLength(1);
    // 参数顺序：user_id, skill_id, candidate_id, command_fingerprint, task_id, platform, outcome
    expect(ins[0].params[0]).toBe(SYSTEM_USER_LOCAL);
    expect(ins[0].params[1]).toBe(null); // skill_id 未给
    expect(ins[0].params[2]).toBe("cand-3");
    expect(ins[0].params[3]).toBe("git:status");
    expect(ins[0].params[5]).toBe("win");
    expect(ins[0].params[6]).toBe("success");
  });
});

describe("Harvester · 鲁棒性：吞错不破坏主链（A4）", () => {
  it("query 抛错时 enqueue 返回 false、recordInvocation 不抛", async () => {
    const q = makeMemQuery({ fail: true });
    const onError = vi.fn();
    const h = createHarvester({ query: q.query, trajectory: makeMemTrajectory().trajectory, onError });

    const ok = await h.enqueue({ signal_role: "soft_seed", source_tool: "add_rule", source_weight: "user_task", contributor_id: SYSTEM_USER_LOCAL, payload: {} });
    expect(ok).toBe(false);
    await expect(
      h.recordInvocation({ user_id: SYSTEM_USER_LOCAL, command_fingerprint: "fp", outcome: "pending" }),
    ).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalled();
  });

  it("轨迹写抛错时 stashTrajectory / recordAction 不抛", async () => {
    const t = makeMemTrajectory({ fail: true });
    const onError = vi.fn();
    const h = createHarvester({ query: makeMemQuery().query, trajectory: t.trajectory, onError });

    await expect(
      h.stashTrajectory("t", [{ action_name: "x" }], "g", "done", ctx),
    ).resolves.toBeUndefined();
    await expect(
      h.recordAction({ user_id: SYSTEM_USER_LOCAL, action_name: "y" }),
    ).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalled();
  });
});
