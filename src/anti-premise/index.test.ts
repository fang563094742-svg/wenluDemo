import { describe, it, expect } from "vitest";
import { analyzePremises, detectSelfPleasing } from "./index.js";

describe("analyzePremises", () => {
  it("命中市场噪音前提", () => {
    const r = analyzePremises("我想做个AI工具赚钱，抓住这波风口");
    expect(r.hiddenAssumptions.length).toBeGreaterThan(0);
    expect(r.contaminationScore).toBeGreaterThan(0);
    expect(r.nextThought).toBeTruthy();
  });

  it("命中身份牢笼前提", () => {
    const r = analyzePremises("我是个普通人，没有资源，只能做点小事");
    expect(r.hiddenAssumptions.some((a) => a.source === "identity")).toBe(true);
  });

  it("干净问题 → 无前提，零污染", () => {
    const r = analyzePremises("今天杭州天气怎么样");
    expect(r.hiddenAssumptions.length).toBe(0);
    expect(r.contaminationScore).toBe(0);
    expect(r.coreContradiction).toBeNull();
  });

  it("空串容错", () => {
    expect(analyzePremises("").hiddenAssumptions.length).toBe(0);
  });

  it("确定性：同输入同输出", () => {
    const q = "市场很卷，我要做差异化的SaaS平台";
    expect(JSON.stringify(analyzePremises(q))).toBe(JSON.stringify(analyzePremises(q)));
  });
});

describe("detectSelfPleasing", () => {
  it("讨好句式 ≥2 → needsRewrite", () => {
    const r = detectSelfPleasing({
      reply: "好主意！完全同意，你说得对，那么我们可以从这几个方向开始。",
      userQuestion: "我该怎么做",
    });
    expect(r.pleasingDetected).toBe(true);
    expect(r.needsRewrite).toBe(true);
    expect(r.rewriteDirective).toBeTruthy();
  });

  it("对含高severity前提的问题列清单 → 命中", () => {
    const r = detectSelfPleasing({
      reply: "1、先选赛道 2、做MVP 3、找用户 首先你要确定方向其次执行",
      userQuestion: "我想做个AI工具赚钱抓住风口",
    });
    expect(r.needsRewrite).toBe(true);
  });

  it("直接拆前提的回复 → 不判谄媚", () => {
    const r = detectSelfPleasing({
      reply: "先停一下。你说的'抓住风口'本身就是个被市场偷走主语的前提。真正该问的是别的。",
      userQuestion: "我想做个AI工具赚钱抓住风口",
    });
    expect(r.needsRewrite).toBe(false);
  });

  it("开篇软化被记为证据", () => {
    const r = detectSelfPleasing({ reply: "听起来你挺纠结的。", userQuestion: "随便问问" });
    expect(r.evidence.some((e) => e.includes("软化"))).toBe(true);
  });
});
