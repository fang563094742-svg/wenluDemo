import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

function evaluateChessTruth(payload: any, expectation: string) {
  const observed = {
    hasTargetRunning: Boolean(payload?.hasTargetRunning),
    isTargetFront: Boolean(payload?.isTargetFront),
    boardVisibleHint: Boolean(payload?.boardVisibleHint),
    gameOverHint: Boolean(payload?.gameOverHint),
    turnHint: payload?.turnHint || "unknown",
  };

  if (expectation === "not-running") {
    return { ok: !observed.hasTargetRunning, blocker: observed.hasTargetRunning ? "app-still-running" : null };
  }
  if (expectation === "running-front") {
    const ok = observed.hasTargetRunning && observed.isTargetFront;
    return { ok, blocker: ok ? null : (!observed.hasTargetRunning ? "app-not-running" : "front-app-mismatch") };
  }
  if (expectation === "in-game") {
    const ok = observed.hasTargetRunning && observed.isTargetFront && observed.boardVisibleHint && !observed.gameOverHint;
    return { ok, blocker: ok ? null : (!observed.hasTargetRunning ? "app-not-running" : !observed.isTargetFront ? "front-app-mismatch" : !observed.boardVisibleHint ? "board-not-visible" : "game-over-state") };
  }
  if (expectation === "game-over") {
    const ok = observed.hasTargetRunning && observed.isTargetFront && observed.gameOverHint;
    return { ok, blocker: ok ? null : (!observed.hasTargetRunning ? "app-not-running" : !observed.isTargetFront ? "front-app-mismatch" : "game-over-not-detected") };
  }
  return { ok: false, blocker: `unknown-expectation:${expectation}` };
}

describe("chess acceptance evaluation", () => {
  it("passes in-game truth when frontmost board is visible", async () => {
    const raw = await readFile("truth.json", "utf-8");
    const payload = JSON.parse(raw);
    payload.hasTargetRunning = true;
    payload.isTargetFront = true;
    payload.boardVisibleHint = true;
    payload.gameOverHint = false;
    const result = evaluateChessTruth(payload, "in-game");
    expect(result.ok).toBe(true);
    expect(result.blocker).toBeNull();
  });

  it("fails game-over expectation when no terminal state hint exists", async () => {
    const raw = await readFile("truth.json", "utf-8");
    const payload = JSON.parse(raw);
    payload.hasTargetRunning = true;
    payload.isTargetFront = true;
    payload.gameOverHint = false;
    const result = evaluateChessTruth(payload, "game-over");
    expect(result.ok).toBe(false);
    expect(result.blocker).toBe("game-over-not-detected");
  });

  it("fails not-running expectation while Chess is still running", async () => {
    const raw = await readFile("truth.json", "utf-8");
    const payload = JSON.parse(raw);
    payload.hasTargetRunning = true;
    const result = evaluateChessTruth(payload, "not-running");
    expect(result.ok).toBe(false);
    expect(result.blocker).toBe("app-still-running");
  });
});
