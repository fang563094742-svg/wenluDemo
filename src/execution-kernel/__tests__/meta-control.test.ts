/**
 * MetaControl 属性测试 — Task 6.2
 * P11 注意力只建议（无副作用）。
 * Validates: Requirements 5.5
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { suggestAttentionRedirect } from "../index.js";

describe("MetaControl · P11 注意力只建议 (Req 5.5)", () => {
  it("反思 shrinkSignal=false 且任务与聚焦不匹配 ⟹ redirect=true 指向聚焦", () => {
    const r = suggestAttentionRedirect({
      currentTaskGoal: "修补net自验证微任务",
      reflection: { verdict: "在打转", shrinkSignal: false, goalFocus: "拿下真实用户交付" },
    });
    expect(r.redirect).toBe(true);
    expect(r.towards).toContain("用户");
  });

  it("差距大且任务与最大差距维度不相关 ⟹ redirect=true", () => {
    const r = suggestAttentionRedirect({
      currentTaskGoal: "整理日志",
      goalGap: { gap: 80, topDimension: "g_results真实产出" },
    });
    expect(r.redirect).toBe(true);
  });

  it("任务与聚焦匹配 ⟹ 不重定向", () => {
    const r = suggestAttentionRedirect({
      currentTaskGoal: "拿下真实用户交付",
      reflection: { verdict: "在缩小差距", shrinkSignal: true, goalFocus: "用户交付" },
    });
    expect(r.redirect).toBe(false);
  });

  it("无信号 ⟹ 不重定向", () => {
    expect(suggestAttentionRedirect({ currentTaskGoal: "x" }).redirect).toBe(false);
  });

  it("无副作用：不改入参", () => {
    fc.assert(
      fc.property(fc.string(), fc.integer({ min: 0, max: 100 }), (goal, gap) => {
        const params = { currentTaskGoal: goal, goalGap: { gap, topDimension: "dim" } };
        const snapshot = JSON.stringify(params);
        suggestAttentionRedirect(params);
        expect(JSON.stringify(params)).toBe(snapshot);
      }),
      { numRuns: 200 },
    );
  });
});
