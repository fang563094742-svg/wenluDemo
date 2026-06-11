/**
 * 认知核三段脊柱 · 调度核测试（dispatch-kernel.ts · dispatch / dispatchSafe）
 * ------------------------------------------------------------------
 * 任务 4.2（属性测试 · Property 4/5/6/7）：
 *  - Property 4: 调度拓扑正确性 — ∀ DAG intent，任一 wave_k 中 line 的
 *    dependsOn 全部出现在严格更早的 wave（∪_{j<k} wave_j 的 subgoalId 集合）。
 *  - Property 5: 调度覆盖且不重复 — flatten(waves).map(subgoalId) 与
 *    intent.subgoals.map(id) 是双射（同一集合、每个恰好一次）。
 *  - Property 6: 并行预算 — ∀ wave，wave.lines.length ≤ maxParallel。
 *  - Property 7: 调度确定性纯函数 — ∀ intent，dispatch(intent) 多次调用结果
 *    深度相等，且调用前后 intent 深快照不变。
 *  **Validates: Requirements 2.1, 2.2, 4.2**
 *
 * 任务 4.3（环检测降级单元测试）：
 *  - 含环 intent（自引用 / a↔b 互相依赖）调 dispatch 抛 DispatchCycleError；
 *    dispatchSafe 对同一含环 intent 降级为单波串行（每波 1 条 line）且不抛、
 *    覆盖全部 subgoal。
 *  _Requirements: 2.5_
 *
 * 绝对边界：仅 import vitest / fast-check 与被测 ../dispatch-kernel.js、../types.js。
 * 不 import 任何 3.1/3.2 路径、不 node:sqlite、不 import riverMain.ts。不改实现。
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";

import {
  dispatch,
  dispatchSafe,
  DispatchCycleError,
} from "../dispatch-kernel.js";
import type {
  DispatchPlan,
  Intent,
  Subgoal,
} from "../types.js";

// ─── 工具：最小 Intent 构造 ───────────────────────────────────

/** 用序号造一个 subgoal id。 */
function sgId(i: number): string {
  return `sg_${i}`;
}

/**
 * 用给定 subgoals 造一个最小 Intent（占位字段填稳定值，subgoals 是重点）。
 */
function makeIntent(subgoals: ReadonlyArray<Subgoal>): Intent {
  return {
    id: "intent_test_0",
    sourceUtterance: null,
    goal: "测试目标",
    subgoals,
    expectedResult: "预期结果",
    acceptanceLine: "验收线",
    status: "planned",
    createdAt: "2026-01-01T00:00:00.000Z",
    mode: "enforce",
  };
}

// ─── 生成器：随机无环 DAG ─────────────────────────────────────

/**
 * 无环 DAG 生成器：N 个节点按序号 0..N-1，每个节点的 dependsOn 只能引用序号
 * 严格更小的节点 ⟹ 拓扑序保证无环、引用完整。priority 由实现确定性推导，
 * 这里不显式设置。
 */
function arbAcyclicDag(): fc.Arbitrary<ReadonlyArray<Subgoal>> {
  return fc
    .integer({ min: 1, max: 10 })
    .chain((n) =>
      fc.tuple(
        ...Array.from({ length: n }, (_, i) =>
          fc.subarray(
            Array.from({ length: i }, (_, j) => j),
            { minLength: 0, maxLength: i },
          ),
        ),
      ),
    )
    .map((depsPerNode) =>
      depsPerNode.map((deps, i) => ({
        id: sgId(i),
        goal: `goal ${i}`,
        dependsOn: deps.map(sgId),
        expectedResult: `result ${i}`,
      })),
    );
}

/** 随机 maxParallel：含缺省（undefined → 4）、1、典型值与大值。 */
function arbMaxParallel(): fc.Arbitrary<number | undefined> {
  return fc.oneof(
    fc.constant(undefined),
    fc.constant(1),
    fc.integer({ min: 1, max: 6 }),
    fc.constant(100),
  );
}

/** 把所有 wave 的 line 拍平。 */
function flattenLines(plan: DispatchPlan) {
  return plan.waves.flatMap((w) => w.lines);
}

// ─── 任务 4.2 · Property 4 拓扑正确性 ─────────────────────────

describe("dispatch · Property 4 调度拓扑正确性 (Req 2.1)", () => {
  it("∀ DAG intent，任一 wave_k 中 line 的 dependsOn ⊆ ∪_{j<k} wave_j", () => {
    fc.assert(
      fc.property(arbAcyclicDag(), arbMaxParallel(), (subgoals, mp) => {
        const intent = makeIntent(subgoals);
        const plan =
          mp === undefined
            ? dispatch(intent)
            : dispatch(intent, { maxParallel: mp });

        const seenBefore = new Set<string>();
        for (const wave of plan.waves) {
          // 校验本波每条 line 的依赖都在严格更早的波。
          for (const line of wave.lines) {
            for (const dep of line.dependsOn) {
              expect(seenBefore.has(dep)).toBe(true);
            }
          }
          // 本波处理完后再纳入 seen（保证"严格更早"）。
          for (const line of wave.lines) {
            seenBefore.add(line.subgoalId);
          }
        }
      }),
      { numRuns: 300 },
    );
  });
});

// ─── 任务 4.2 · Property 5 覆盖且不重复 ───────────────────────

describe("dispatch · Property 5 调度覆盖且不重复 (Req 2.1)", () => {
  it("∀ DAG intent，flatten(waves).subgoalId 与 subgoals.id 双射", () => {
    fc.assert(
      fc.property(arbAcyclicDag(), arbMaxParallel(), (subgoals, mp) => {
        const intent = makeIntent(subgoals);
        const plan =
          mp === undefined
            ? dispatch(intent)
            : dispatch(intent, { maxParallel: mp });

        const scheduledIds = flattenLines(plan).map((l) => l.subgoalId);
        const expectedIds = subgoals.map((s) => s.id);

        // 每个恰好出现一次：数量相等且无重复。
        expect(scheduledIds.length).toBe(expectedIds.length);
        expect(new Set(scheduledIds).size).toBe(scheduledIds.length);
        // 同一集合（顺序无关）。
        expect([...scheduledIds].sort()).toEqual([...expectedIds].sort());
      }),
      { numRuns: 300 },
    );
  });
});

// ─── 任务 4.2 · Property 6 并行预算 ───────────────────────────

describe("dispatch · Property 6 并行预算 (Req 2.2)", () => {
  it("∀ wave，wave.lines.length ≤ maxParallel", () => {
    fc.assert(
      fc.property(arbAcyclicDag(), arbMaxParallel(), (subgoals, mp) => {
        const intent = makeIntent(subgoals);
        const effective = mp === undefined ? 4 : mp; // 缺省对齐 MAX_PARALLEL=4
        const plan =
          mp === undefined
            ? dispatch(intent)
            : dispatch(intent, { maxParallel: mp });

        for (const wave of plan.waves) {
          expect(wave.lines.length).toBeLessThanOrEqual(effective);
        }
      }),
      { numRuns: 300 },
    );
  });
});

// ─── 任务 4.2 · Property 7 确定性纯函数 ───────────────────────

describe("dispatch · Property 7 调度确定性纯函数 (Req 4.2)", () => {
  it("∀ intent，多次 dispatch 深度相等", () => {
    fc.assert(
      fc.property(arbAcyclicDag(), arbMaxParallel(), (subgoals, mp) => {
        const intent = makeIntent(subgoals);
        const opts = mp === undefined ? undefined : { maxParallel: mp };
        const a = dispatch(intent, opts);
        const b = dispatch(intent, opts);
        expect(a).toEqual(b);
      }),
      { numRuns: 300 },
    );
  });

  it("∀ intent，dispatch 不修改入参（前后深快照不变）", () => {
    fc.assert(
      fc.property(arbAcyclicDag(), arbMaxParallel(), (subgoals, mp) => {
        const intent = makeIntent(subgoals);
        const before = JSON.parse(JSON.stringify(intent));
        const opts = mp === undefined ? undefined : { maxParallel: mp };
        dispatch(intent, opts);
        expect(intent).toEqual(before);
      }),
      { numRuns: 300 },
    );
  });
});

// ─── 任务 4.3 · 环检测降级单元测试 (Req 2.5) ──────────────────

describe("dispatch / dispatchSafe · 环检测降级 (Req 2.5)", () => {
  /** 自引用含环 intent。 */
  function selfRefIntent(): Intent {
    return makeIntent([
      { id: "a", goal: "ga", dependsOn: ["a"], expectedResult: "ra" },
    ]);
  }

  /** a↔b 互相依赖含环 intent。 */
  function mutualIntent(): Intent {
    return makeIntent([
      { id: "a", goal: "ga", dependsOn: ["b"], expectedResult: "ra" },
      { id: "b", goal: "gb", dependsOn: ["a"], expectedResult: "rb" },
    ]);
  }

  it("自引用 intent ⟹ dispatch 抛 DispatchCycleError", () => {
    expect(() => dispatch(selfRefIntent())).toThrow(DispatchCycleError);
  });

  it("a↔b 互相依赖 intent ⟹ dispatch 抛 DispatchCycleError", () => {
    expect(() => dispatch(mutualIntent())).toThrow(DispatchCycleError);
  });

  it("dispatchSafe 对自引用 intent 降级为单波串行且不抛、覆盖全部 subgoal", () => {
    const intent = selfRefIntent();
    let plan: DispatchPlan | undefined;
    expect(() => {
      plan = dispatchSafe(intent);
    }).not.toThrow();

    const p = plan as DispatchPlan;
    // 每波恰好 1 条 line（串行）。
    for (const wave of p.waves) {
      expect(wave.lines.length).toBe(1);
    }
    // 覆盖全部 subgoal。
    const ids = flattenLines(p).map((l) => l.subgoalId);
    expect([...ids].sort()).toEqual(intent.subgoals.map((s) => s.id).sort());
  });

  it("dispatchSafe 对 a↔b 含环 intent 降级为单波串行且不抛、覆盖全部 subgoal", () => {
    const intent = mutualIntent();
    let plan: DispatchPlan | undefined;
    expect(() => {
      plan = dispatchSafe(intent);
    }).not.toThrow();

    const p = plan as DispatchPlan;
    expect(p.waves.length).toBe(intent.subgoals.length);
    for (const wave of p.waves) {
      expect(wave.lines.length).toBe(1);
    }
    const ids = flattenLines(p).map((l) => l.subgoalId);
    expect([...ids].sort()).toEqual(intent.subgoals.map((s) => s.id).sort());
  });
});
