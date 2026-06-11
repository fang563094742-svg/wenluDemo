/**
 * wait-eval 单元测试：唤醒条件满足判定 + 超时 + 上限规整。
 * Validates: Requirements 2.2, 2.3, 2.5
 */
import { describe, it, expect } from "vitest";
import {
  isWakeSatisfied,
  isWaitTimeout,
  clampWaitTimeout,
  type WakeCondition,
} from "../index.js";

describe("wait-eval · isWakeSatisfied", () => {
  it("file_appears：ready=true ⟹ 满足", () => {
    const w: WakeCondition = { kind: "file_appears", spec: { path: "/tmp/x" }, describe: "等文件" };
    expect(isWakeSatisfied(w, { ready: true })).toBe(true);
    expect(isWakeSatisfied(w, { ready: false })).toBe(false);
    expect(isWakeSatisfied(w, undefined)).toBe(false);
  });
  it("opponent_moved：observed 含 expect ⟹ 满足", () => {
    const w: WakeCondition = { kind: "opponent_moved", spec: { expect: "黑方走棋" }, describe: "等对手" };
    expect(isWakeSatisfied(w, { observed: "游戏1 | 黑方走棋" })).toBe(true);
    expect(isWakeSatisfied(w, { observed: "白方走棋" })).toBe(false);
  });
  it("window_state 无 expect ⟹ 退回 ready", () => {
    const w: WakeCondition = { kind: "window_state", spec: {}, describe: "等窗口" };
    expect(isWakeSatisfied(w, { ready: true })).toBe(true);
  });
});

describe("wait-eval · 超时与上限", () => {
  it("超时判定", () => {
    expect(isWaitTimeout(1000, 5000, 7000)).toBe(true);
    expect(isWaitTimeout(1000, 5000, 5500)).toBe(false);
  });
  it("非法输入不超时", () => {
    expect(isWaitTimeout(NaN, 5000, 7000)).toBe(false);
  });
  it("超时上限封顶 10 分钟、缺省 5 分钟", () => {
    expect(clampWaitTimeout(undefined)).toBe(300_000);
    expect(clampWaitTimeout(999_999_999)).toBe(600_000);
    expect(clampWaitTimeout(120_000)).toBe(120_000);
    expect(clampWaitTimeout(-5)).toBe(300_000);
  });
});
