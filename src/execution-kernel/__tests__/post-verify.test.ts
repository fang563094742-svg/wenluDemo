/**
 * post-verify 单元/属性测试
 * 验证：独立结果验证判定 + failedAttempts 防重复犯错。
 * Validates: Requirements 1.2, 1.3, 1.5, 1.8
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  VERIFY_POLICY,
  needsPostVerify,
  commandHasSideEffect,
  judgePostVerify,
  shouldForceNewApproach,
} from "../index.js";

describe("post-verify · 策略表与副作用判定", () => {
  it("always 类工具恒需验证", () => {
    expect(needsPostVerify("write_file", false)).toBe(true);
    expect(needsPostVerify("use_mastered_tool", false)).toBe(true);
  });
  it("never 类工具恒不验证", () => {
    expect(needsPostVerify("read_file", true)).toBe(false);
    expect(needsPostVerify("focus_native_app", true)).toBe(false);
  });
  it("on-side-effect 仅在有副作用时验证", () => {
    expect(needsPostVerify("execute_command", false)).toBe(false);
    expect(needsPostVerify("execute_command", true)).toBe(true);
  });
  it("未知工具默认不验证", () => {
    expect(needsPostVerify("some_unknown_tool", true)).toBe(false);
  });
  it("commandHasSideEffect 识别重定向/删除/kill", () => {
    expect(commandHasSideEffect("echo x > /tmp/a")).toBe(true);
    expect(commandHasSideEffect("rm /tmp/a")).toBe(true);
    expect(commandHasSideEffect("kill 123")).toBe(true);
    expect(commandHasSideEffect("ls -la")).toBe(false);
    expect(commandHasSideEffect("cat file")).toBe(false);
  });
  it("VERIFY_POLICY 覆盖关键工具", () => {
    expect(VERIFY_POLICY.write_file).toBe("always");
    expect(VERIFY_POLICY.read_file).toBe("never");
  });
});

describe("post-verify · judgePostVerify 独立验证判定", () => {
  it("无证据 ⟹ passed 但标注未验证（fail-open）", () => {
    const r = judgePostVerify({ toolName: "write_file", args: {} });
    expect(r.passed).toBe(true);
    expect(r.evidence).toContain("not verified");
  });
  it("write_file 文件不存在 ⟹ 不通过", () => {
    const r = judgePostVerify({ toolName: "write_file", args: { content: "hi" }, evidence: { targetExists: false } });
    expect(r.passed).toBe(false);
    expect(r.reason).toContain("不存在");
  });
  it("write_file 回读内容含预期 ⟹ 通过", () => {
    const r = judgePostVerify({ toolName: "write_file", args: { content: "hello world" }, evidence: { targetExists: true, readbackContent: "hello world!!" } });
    expect(r.passed).toBe(true);
  });
  it("write_file 回读内容不符 ⟹ 不通过", () => {
    const r = judgePostVerify({ toolName: "write_file", args: { content: "hello" }, evidence: { targetExists: true, readbackContent: "goodbye" } });
    expect(r.passed).toBe(false);
    expect(r.reason).toContain("不符");
  });
  it("delete_file 目标已删 ⟹ 通过", () => {
    expect(judgePostVerify({ toolName: "delete_file", args: {}, evidence: { targetExists: false } }).passed).toBe(true);
    expect(judgePostVerify({ toolName: "delete_file", args: {}, evidence: { targetExists: true } }).passed).toBe(false);
  });
  it("execute_command kill 进程仍在 ⟹ 不通过", () => {
    const r = judgePostVerify({ toolName: "execute_command", args: { command: "kill 999" }, evidence: { processStillRunning: true } });
    expect(r.passed).toBe(false);
  });
  it("execute_command kill 进程已停 ⟹ 通过", () => {
    const r = judgePostVerify({ toolName: "execute_command", args: { command: "pkill node" }, evidence: { processStillRunning: false } });
    expect(r.passed).toBe(true);
  });
});

describe("post-verify · shouldForceNewApproach 防重复犯错", () => {
  it("同一动作连续失败达阈值 ⟹ 强制换方案", () => {
    const fails = [
      { action: "use_mastered_tool(a)", reason: "x" },
      { action: "use_mastered_tool(b)", reason: "y" },
      { action: "use_mastered_tool(c)", reason: "z" },
    ];
    const r = shouldForceNewApproach(fails, "use_mastered_tool", 3);
    expect(r.force).toBe(true);
    expect(r.count).toBe(3);
  });
  it("未达阈值 ⟹ 不强制", () => {
    const r = shouldForceNewApproach([{ action: "write_file(x)", reason: "e" }], "write_file", 3);
    expect(r.force).toBe(false);
  });
  it("∀ 历史与阈值，force ⟺ count>=threshold", () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ action: fc.constantFrom("toolA(x)", "toolB(y)"), reason: fc.string() }), { maxLength: 12 }),
        fc.integer({ min: 1, max: 5 }),
        (fails, th) => {
          const r = shouldForceNewApproach(fails, "toolA", th);
          const cnt = fails.filter((f) => f.action.startsWith("toolA")).length;
          expect(r.count).toBe(cnt);
          expect(r.force).toBe(cnt >= th);
        },
      ),
      { numRuns: 200 },
    );
  });
});
