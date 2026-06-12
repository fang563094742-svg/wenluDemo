/**
 * ActiveReuse（主动复用触发：T4 救援 + T5 查库）单元测试。
 *
 * 全部依赖注入式 mock（mock retrieve + 可控「假超时」timer），独立可跑（不连真实 PG /
 * 真实 LLM / 真实连接器）。覆盖任务 14 / Req 19.9 的异步超时核心语义：
 *  - 命中作候选：超时内检索到 → outcome=hit，返回候选 + 软提示。
 *  - 未命中不阻塞：超时内检索完成但空集（或检索失败）→ outcome=miss，不阻塞。
 *  - 超时视未命中：超时先到 → outcome=timeout，任务立即继续。
 *  - 迟到仅参考：超时后检索才返回非空 → 仅经 onLate 回调作参考，不二次 settle、不中断当前执行。
 *
 * _Requirements: 19.1, 19.2, 19.3, 19.4, 19.5, 19.6, 19.7, 19.8, 19.9_
 */

import { describe, expect, it, vi } from "vitest";

import {
  createActiveReuse,
  formatReuseHint,
  raceWithTimeout,
  type RetrieveFn,
  type TimerLike,
} from "../activeReuse.js";
import type { RetrievedSkill } from "../dispatcher.js";

// ── 测试夹具 ──

function makeRetrieved(id: string, opts: { scenario?: string; unverified?: boolean } = {}): RetrievedSkill {
  return {
    summary: {
      id,
      name: `技能 ${id}`,
      description: `描述 ${id}`,
      applicable_scenario: opts.scenario ?? `场景 ${id}`,
      category: "general",
      tags: ["t1"],
      quality_score: 0.8,
      platform_variant_count: 0,
    },
    platform_status: opts.unverified ? "needs_render" : "platform_agnostic",
    dispatchable: true,
    unverified_on_platform: !!opts.unverified,
  };
}

/** 可手动触发的「假超时」timer：setTimer 只登记回调，由 fire() 显式触发。 */
function manualTimer(): { timer: TimerLike; fire: () => void; hasPending: () => boolean } {
  let pending: (() => void) | null = null;
  return {
    timer: {
      setTimer: (fn: () => void) => {
        pending = fn;
        return 1;
      },
      clearTimer: () => {
        pending = null;
      },
    },
    fire: () => {
      const f = pending;
      pending = null;
      f?.();
    },
    hasPending: () => pending !== null,
  };
}

/** 可外部 resolve/reject 的 deferred。 */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e?: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 让微任务队列与一次宏任务彻底排空。 */
async function flush(): Promise<void> {
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

const req = { userId: "u1", query: "目标 + 失败上下文", platform: "win" as const };

describe("ActiveReuse · 命中作候选（Req 19.1/19.3/19.5/19.6）", () => {
  it("T4 超时内检索到匹配 → outcome=hit，返回候选 + 软提示", async () => {
    const mt = manualTimer();
    const retrieve: RetrieveFn = vi.fn(async () => [makeRetrieved("s1"), makeRetrieved("s2")]);
    const ar = createActiveReuse({ retrieve, timer: mt.timer, timeoutMs: 5000 });

    const res = await ar.rescueRetrieve(req);

    expect(res.outcome).toBe("hit");
    expect(res.timedOut).toBe(false);
    expect(res.candidates.map((c) => c.summary.id)).toEqual(["s1", "s2"]);
    expect(res.hint).toContain("【T4·救援");
    expect(res.hint).toContain("技能 s1");
    expect(retrieve).toHaveBeenCalledWith(req);
  });

  it("T5 命中 → outcome=hit，提示「优先复用而非新造」", async () => {
    const mt = manualTimer();
    const retrieve: RetrieveFn = vi.fn(async () => [makeRetrieved("dup")]);
    const ar = createActiveReuse({ retrieve, timer: mt.timer });

    const res = await ar.preForgeLookup({ userId: "u1", query: "造个新能力" });
    expect(res.outcome).toBe("hit");
    expect(res.hint).toContain("【T5");
    expect(res.hint).toContain("技能 dup");
  });

  it("needs_render 命中标注「未在你平台验证」", async () => {
    const mt = manualTimer();
    const retrieve: RetrieveFn = async () => [makeRetrieved("s1", { unverified: true })];
    const ar = createActiveReuse({ retrieve, timer: mt.timer });

    const res = await ar.rescueRetrieve(req);
    expect(res.hint).toContain("（未在你平台验证）");
  });
});

describe("ActiveReuse · 未命中不阻塞（Req 19.4）", () => {
  it("超时内检索完成但空集 → outcome=miss，hint 为空，不阻塞", async () => {
    const mt = manualTimer();
    const retrieve: RetrieveFn = vi.fn(async () => []);
    const ar = createActiveReuse({ retrieve, timer: mt.timer });

    const res = await ar.rescueRetrieve(req);
    expect(res.outcome).toBe("miss");
    expect(res.candidates).toEqual([]);
    expect(res.hint).toBe("");
    expect(res.timedOut).toBe(false);
  });

  it("检索在超时内失败（reject）→ 按未命中处理，不抛错", async () => {
    const mt = manualTimer();
    const retrieve: RetrieveFn = async () => {
      throw new Error("检索炸了");
    };
    const ar = createActiveReuse({ retrieve, timer: mt.timer });

    const res = await ar.rescueRetrieve(req);
    expect(res.outcome).toBe("miss");
    expect(res.timedOut).toBe(false);
  });
});

describe("ActiveReuse · 超时视未命中、任务立即继续（Req 19.9）", () => {
  it("超时先到 → outcome=timeout，candidates 为空", async () => {
    const mt = manualTimer();
    const never = deferred<RetrievedSkill[]>(); // 永不在超时内返回
    const ar = createActiveReuse({ retrieve: () => never.promise, timer: mt.timer, timeoutMs: 50 });

    const p = ar.rescueRetrieve(req);
    // setTimer 已在 raceWithTimeout 内同步登记 → 手动触发「假超时」。
    expect(mt.hasPending()).toBe(true);
    mt.fire();

    const res = await p;
    expect(res.outcome).toBe("timeout");
    expect(res.timedOut).toBe(true);
    expect(res.candidates).toEqual([]);
    expect(res.hint).toBe("");
  });
});

describe("ActiveReuse · 迟到仅作参考、不中断当前执行（Req 19.9）", () => {
  it("超时后检索才返回非空 → 仅经 onLate 回调，不二次 settle", async () => {
    const mt = manualTimer();
    const late = deferred<RetrievedSkill[]>();
    const onLate = vi.fn();
    const ar = createActiveReuse({ retrieve: () => late.promise, timer: mt.timer, timeoutMs: 50 });

    const p = ar.rescueRetrieve(req, { onLate });
    mt.fire(); // 先超时
    const res = await p;
    expect(res.outcome).toBe("timeout");
    expect(onLate).not.toHaveBeenCalled(); // 迟到结果还没到

    // 检索迟到返回命中 → 仅作参考交回 onLate。
    late.resolve([makeRetrieved("late1")]);
    await flush();

    expect(onLate).toHaveBeenCalledOnce();
    const arg = onLate.mock.calls[0][0] as { candidates: RetrievedSkill[]; hint: string };
    expect(arg.candidates.map((c) => c.summary.id)).toEqual(["late1"]);
    expect(arg.hint).toContain("技能 late1");
    // 当前执行的结果对象未被迟到结果改写（仍是 timeout 三态）。
    expect(res.outcome).toBe("timeout");
  });

  it("迟到结果为空集 → 不打扰，不回调 onLate", async () => {
    const mt = manualTimer();
    const late = deferred<RetrievedSkill[]>();
    const onLate = vi.fn();
    const ar = createActiveReuse({ retrieve: () => late.promise, timer: mt.timer, timeoutMs: 50 });

    const p = ar.rescueRetrieve(req, { onLate });
    mt.fire();
    await p;

    late.resolve([]); // 迟到但空集
    await flush();
    expect(onLate).not.toHaveBeenCalled();
  });

  it("迟到检索失败（reject）→ 静默丢弃，不回调、不抛", async () => {
    const mt = manualTimer();
    const late = deferred<RetrievedSkill[]>();
    const onLate = vi.fn();
    const ar = createActiveReuse({ retrieve: () => late.promise, timer: mt.timer, timeoutMs: 50 });

    const p = ar.rescueRetrieve(req, { onLate });
    mt.fire();
    await p;

    late.reject(new Error("迟到也炸了"));
    await flush();
    expect(onLate).not.toHaveBeenCalled();
  });
});

describe("raceWithTimeout · 竞速内核", () => {
  it("超时分支 resolve 后，原 Promise 迟到 resolve 不会二次 settle", async () => {
    const mt = manualTimer();
    const d = deferred<number>();
    const onLate = vi.fn();

    const p = raceWithTimeout(d.promise, 10, { timer: mt.timer, onLate });
    mt.fire();
    const r = await p;
    expect(r.timedOut).toBe(true);
    expect(r.value).toBeUndefined();

    d.resolve(42); // 迟到
    await flush();
    expect(onLate).toHaveBeenCalledWith(42);
  });

  it("超时内 resolve → timedOut=false 且带 value", async () => {
    const mt = manualTimer();
    const r = await raceWithTimeout(Promise.resolve("ok"), 1000, { timer: mt.timer });
    expect(r.timedOut).toBe(false);
    expect(r.value).toBe("ok");
  });
});

describe("formatReuseHint · 提示格式化", () => {
  it("空结果返回空串", () => {
    expect(formatReuseHint([], "【头】", 3)).toBe("");
  });

  it("最多列出 max 条", () => {
    const hint = formatReuseHint(
      [makeRetrieved("a"), makeRetrieved("b"), makeRetrieved("c")],
      "【头】",
      2,
    );
    expect(hint).toContain("技能 a");
    expect(hint).toContain("技能 b");
    expect(hint).not.toContain("技能 c");
  });
});

describe("createActiveReuse · 依赖校验与默认超时", () => {
  it("未注入 retrieve 也未注入 dispatcher → 抛错", () => {
    expect(() => createActiveReuse({})).toThrow();
  });

  it("默认超时取 config.T4T5_Timeout_ms", async () => {
    // 用一个会同步 resolve 的 retrieve，验证不依赖显式 timeoutMs 也能正常返回。
    const ar = createActiveReuse({ retrieve: async () => [makeRetrieved("s1")] });
    const res = await ar.rescueRetrieve(req);
    expect(res.outcome).toBe("hit");
  });
});
