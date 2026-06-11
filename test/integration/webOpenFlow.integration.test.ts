import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../../src/index.js";
import { createInitialSession, SessionState } from "../../src/orchestrator/session.js";

class StubScanner {
  isSupported() { return false; }
  async scan() { throw new Error("unused"); }
}

class StubLlmProvider {
  providerKey = "stub-web-open";
  async complete() { throw new Error("unused"); }
  async completeWithTools() { throw new Error("unused"); }
}

const started: ReturnType<typeof buildApp>[] = [];

describe("web open flow", () => {
  afterEach(async () => {
    while (started.length) {
      const app = started.pop();
      if (!app) break;
      try { await app.webServer.shutdown("test done", 0); } catch {}
    }
  });

  it("returns delivered state snapshot and accept-delivery next action after open", async () => {
    const app = buildApp({ llmProvider: new StubLlmProvider() as any, scanner: new StubScanner() as any, platform: "linux" });
    started.push(app);

    const session = createInitialSession("test");
    session.state = SessionState.Delivered;
    (app.orchestrator as any).session = session;

    await app.webServer.start({ port: 0, uiReadyTimeoutMs: 0 });
    const addr = app.webServer.address();
    const res = await fetch(`http://127.0.0.1:${addr?.port}/state`);
    const body: any = await res.json();

    expect(body.ok).toBe(true);
    expect(body.state).toBe(SessionState.Delivered);
    expect(body.nextActions).toEqual([
      { endpoint: "/accept-delivery", method: "POST", label: "确认完成" },
    ]);
  });
});
