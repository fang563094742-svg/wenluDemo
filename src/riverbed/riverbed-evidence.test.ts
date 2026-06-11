import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  normalizeEvidenceRefs,
  normalizeConstraintRefs,
  type RiverbedEvidenceRef,
  type RiverbedConstraintRef,
} from "./riverbed-evidence.js";

const EVIDENCE_KINDS = [
  "belief",
  "userModel",
  "knowledge",
  "conversation",
  "episode",
  "prediction",
  "manual",
] as const;

const REF_ROLES = ["supporting", "contradicting", "context"] as const;

/** 生成任意证据引用（refId 可能为空白 / 含前后空格，便于覆盖 trim + 去空逻辑）。 */
const evidenceRefArb: fc.Arbitrary<RiverbedEvidenceRef> = fc.record(
  {
    kind: fc.constantFrom(...EVIDENCE_KINDS),
    refId: fc.oneof(
      fc.string(),
      // 倾向产出可碰撞的小集合，提升重复 kind:refId 的命中率
      fc.constantFrom("r1", "r2", "r3", " r1 ", "", "   "),
    ),
    label: fc.option(fc.string(), { nil: undefined }),
    refRole: fc.option(fc.constantFrom(...REF_ROLES), { nil: undefined }),
  },
  { requiredKeys: ["kind", "refId"] },
);

describe("normalizeEvidenceRefs — Property 9: 证据归一化去重", () => {
  // **Validates: Requirements 2.6, 6.3**
  it("归一化后不存在两条相同的 kind:refId 复合键", () => {
    fc.assert(
      fc.property(fc.array(evidenceRefArb), (refs) => {
        const out = normalizeEvidenceRefs(refs);
        const keys = out.map((r) => `${r.kind}:${r.refId}`);
        expect(new Set(keys).size).toBe(keys.length);
      }),
    );
  });

  it("空 / 纯空白 refId 的引用被丢弃（产出 refId 一律非空）", () => {
    fc.assert(
      fc.property(fc.array(evidenceRefArb), (refs) => {
        const out = normalizeEvidenceRefs(refs);
        for (const r of out) {
          expect(r.refId.length).toBeGreaterThan(0);
          expect(r.refId).toBe(r.refId.trim());
        }
      }),
    );
  });

  it("保留每个复合键首次出现的顺序", () => {
    fc.assert(
      fc.property(fc.array(evidenceRefArb), (refs) => {
        const out = normalizeEvidenceRefs(refs);
        // 重建“期望的首次出现顺序”：扫描原列表，按归一化规则取首现
        const seen = new Set<string>();
        const expectedKeys: string[] = [];
        for (const ref of refs) {
          const refId = ref.refId.trim();
          if (!refId) continue;
          const key = `${ref.kind}:${refId}`;
          if (seen.has(key)) continue;
          seen.add(key);
          expectedKeys.push(key);
        }
        const actualKeys = out.map((r) => `${r.kind}:${r.refId}`);
        expect(actualKeys).toEqual(expectedKeys);
      }),
    );
  });
});

describe("normalizeEvidenceRefs — 单元示例", () => {
  it("去重同 kind:refId,保留首次,丢弃空 refId", () => {
    const refs: RiverbedEvidenceRef[] = [
      { kind: "belief", refId: "b1", label: "首次" },
      { kind: "belief", refId: " b1 ", label: "重复(trim后同键)" },
      { kind: "belief", refId: "   " },
      { kind: "userModel", refId: "u1" },
      { kind: "belief", refId: "" },
    ];
    const out = normalizeEvidenceRefs(refs);
    expect(out).toEqual([
      { kind: "belief", refId: "b1", label: "首次" },
      { kind: "userModel", refId: "u1" },
    ]);
  });

  it("空 / undefined 输入返回空数组", () => {
    expect(normalizeEvidenceRefs()).toEqual([]);
    expect(normalizeEvidenceRefs([])).toEqual([]);
  });
});

describe("normalizeConstraintRefs — 去重单元测试", () => {
  it("按 constraintId 去重并保留首次出现", () => {
    const refs: RiverbedConstraintRef[] = [
      { constraintId: "c1", source: "rule", summary: "首次", evidenceRefs: [] },
      { constraintId: " c1 ", source: "value", summary: "重复(trim后同键)", evidenceRefs: [] },
      { constraintId: "c2", source: "domain", summary: " 摘要 ", evidenceRefs: [] },
    ];
    const out = normalizeConstraintRefs(refs);
    expect(out.map((c) => c.constraintId)).toEqual(["c1", "c2"]);
    expect(out[0].summary).toBe("首次");
    expect(out[1].summary).toBe("摘要");
  });

  it("丢弃 constraintId 为空 / 纯空白的约束", () => {
    const refs: RiverbedConstraintRef[] = [
      { constraintId: "", source: "rule", summary: "空", evidenceRefs: [] },
      { constraintId: "   ", source: "manual", summary: "空白", evidenceRefs: [] },
      { constraintId: "ok", source: "domain", summary: "保留", evidenceRefs: [] },
    ];
    expect(normalizeConstraintRefs(refs).map((c) => c.constraintId)).toEqual(["ok"]);
  });

  it("内部 evidenceRefs 同样被归一化去重", () => {
    const refs: RiverbedConstraintRef[] = [
      {
        constraintId: "c1",
        source: "rule",
        summary: "x",
        evidenceRefs: [
          { kind: "belief", refId: "b1" },
          { kind: "belief", refId: "b1" },
          { kind: "belief", refId: "  " },
        ],
      },
    ];
    const out = normalizeConstraintRefs(refs);
    expect(out[0].evidenceRefs).toEqual([{ kind: "belief", refId: "b1" }]);
  });

  it("空 / undefined 输入返回空数组", () => {
    expect(normalizeConstraintRefs()).toEqual([]);
    expect(normalizeConstraintRefs([])).toEqual([]);
  });
});
