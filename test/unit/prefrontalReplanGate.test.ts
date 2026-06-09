import { describe, expect, it } from "vitest";

import {
  createInteractionState,
  onReplanHandled,
  onUserMessage,
  prefrontal,
} from "../../src/prefrontal.js";

describe("prefrontal replan gate", () => {
  it("replies to a fresh user message before allowing replan handling", () => {
    const state = createInteractionState();
    onUserMessage(state, 1_000);

    const decision = prefrontal(state, 2_000);

    expect(decision.action).toBe("reply-user");
    expect(state.replanRequired).toBe(true);
  });

  it("keeps forcing replan until a new-direction reply is actually sent", () => {
    const state = createInteractionState();
    onUserMessage(state, 1_000);
    onReplanHandled(state, false);

    const decision = prefrontal(state, 70_000);

    expect(state.replanRequired).toBe(true);
    expect(decision.action).toBe("replan-after-user");
  });

  it("clears the replan gate only after a new-direction reply is sent", () => {
    const state = createInteractionState();
    onUserMessage(state, 1_000);
    onReplanHandled(state, true);

    const decision = prefrontal(state, 70_000);

    expect(state.replanRequired).toBe(false);
    expect(decision.action).toBe("breathe");
  });
});
