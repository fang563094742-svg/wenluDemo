/**
 * 认知核三段脊柱 · DAG 工具测试（types.ts · isValidDag）
 * ------------------------------------------------------------------
 * 覆盖（任务 2.3 · Property 2 DAG 工具部分）：
 *  - isValidDag 对随机生成的无环图返回 true
 *    （拓扑序生成器：节点 0..N-1，dependsOn 只引用更小序号 ⟹ 必无环）。
 *  - isValidDag 对含环图 / 坏引用 / 自引用返回 false。
 *  **Validates: Requirements 6.1, 6.2, 6.3**
 *  （Property 2 主映射 Req 1.1，此处随任务 2.3 就近落地 DAG 工具校验。）
 *
 * 绝对边界：仅 import vitest / fast-check 与被测 ../types.js。
 * 不 import 任何 3.1/3.2 路径、不 node:sqlite、不 import riverMain.ts。不改实现。
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";

import { isValidDag, type Subgoal } from "../types.js";

/** 用序号造一个 subgoal id。 */
function sgId(i: number): string {
  return `sg_${i}`;
}

/**
 * 无环 DAG 生成器：N 个节点按序号 0..N-1，每个节点的 dependsOn 只能引用
 * 序号严格更小的节点 ⟹ 拓扑序保证无环、引用完整。
 */
function arbAcyclicDag(): fc.Arbitrary<ReadonlyArray<Subgoal>> {
  return fc
    .integer({ min: 1, max: 8 })
    .chain((n) =>
      fc.tuple(
        ...Array.from({ length: n }, (_, i) =>
          // 节点 i 的依赖：从 {0..i-1} 中任选子集
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

/**
 * 含环图生成器：先造无环 DAG，再注入一条**必然成环**的边。
 *
 * 注意：单纯加一条 i→j（i 依赖 j）的"前向边"不保证成环——只有当 j 已
 * 存在回到 i 的路径时才成环。为可靠构造环，这里只用两种确定成环的策略：
 *  - 自引用：节点 idx 依赖自身（idx → idx）。
 *  - 2-环：选两个不同节点 a、b，强制 a 依赖 b 且 b 依赖 a（a → b → a）。
 */
function arbCyclicDag(): fc.Arbitrary<ReadonlyArray<Subgoal>> {
  return arbAcyclicDag()
    .filter((dag) => dag.length >= 1)
    .chain((dag) => {
      // 自引用策略（任意 n ≥ 1 均可）。
      const selfRef = fc
        .integer({ min: 0, max: dag.length - 1 })
        .map((idx) =>
          dag.map((sg, i) =>
            i === idx
              ? { ...sg, dependsOn: [...sg.dependsOn, sgId(idx)] }
              : sg,
          ),
        );

      // 2-环策略（需 n ≥ 2）：强制 a↔b 互相依赖。
      if (dag.length < 2) {
        return selfRef;
      }
      const twoCycle = fc
        .tuple(
          fc.integer({ min: 0, max: dag.length - 1 }),
          fc.integer({ min: 0, max: dag.length - 2 }),
        )
        .map(([a, rawB]) => {
          const b = rawB >= a ? rawB + 1 : rawB; // 保证 b !== a
          return dag.map((sg, i) => {
            if (i === a) {
              return { ...sg, dependsOn: [...sg.dependsOn, sgId(b)] };
            }
            if (i === b) {
              return { ...sg, dependsOn: [...sg.dependsOn, sgId(a)] };
            }
            return sg;
          });
        });

      return fc.oneof(selfRef, twoCycle);
    });
}

describe("isValidDag · Property 2 无环图返回 true (Req 6.1)", () => {
  it("∀ 拓扑序生成的无环图 ⟹ isValidDag === true", () => {
    fc.assert(
      fc.property(arbAcyclicDag(), (subgoals) => {
        expect(isValidDag(subgoals)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it("空子目标列表视为合法 DAG", () => {
    expect(isValidDag([])).toBe(true);
  });
});

describe("isValidDag · Property 2 含环/坏引用图返回 false (Req 6.1)", () => {
  it("∀ 注入回边/自引用的图 ⟹ isValidDag === false", () => {
    fc.assert(
      fc.property(arbCyclicDag(), (subgoals) => {
        expect(isValidDag(subgoals)).toBe(false);
      }),
      { numRuns: 300 },
    );
  });

  it("dependsOn 引用不存在的 id ⟹ false", () => {
    const subgoals: ReadonlyArray<Subgoal> = [
      {
        id: "a",
        goal: "g",
        dependsOn: ["ghost"],
        expectedResult: "r",
      },
    ];
    expect(isValidDag(subgoals)).toBe(false);
  });

  it("自引用 ⟹ false", () => {
    const subgoals: ReadonlyArray<Subgoal> = [
      { id: "a", goal: "g", dependsOn: ["a"], expectedResult: "r" },
    ];
    expect(isValidDag(subgoals)).toBe(false);
  });

  it("二节点互相依赖（2-环）⟹ false", () => {
    const subgoals: ReadonlyArray<Subgoal> = [
      { id: "a", goal: "ga", dependsOn: ["b"], expectedResult: "ra" },
      { id: "b", goal: "gb", dependsOn: ["a"], expectedResult: "rb" },
    ];
    expect(isValidDag(subgoals)).toBe(false);
  });

  it("重复 id ⟹ false", () => {
    const subgoals: ReadonlyArray<Subgoal> = [
      { id: "a", goal: "g1", dependsOn: [], expectedResult: "r1" },
      { id: "a", goal: "g2", dependsOn: [], expectedResult: "r2" },
    ];
    expect(isValidDag(subgoals)).toBe(false);
  });
});
