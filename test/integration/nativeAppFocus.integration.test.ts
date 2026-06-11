import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  captureFrontAppSnapshot,
  ensureNativeAppPriority,
  listForegroundApps,
} from "../../src/nativeAppFocus.js";

const EVIDENCE_PATH = "/tmp/native_app_focus_chain_evidence.json";

describe("native-app-focus-chain", () => {
  it("can bring Finder frontmost and leave readable evidence", async () => {
    if (process.platform !== "darwin") return;

    const apps = await listForegroundApps();
    expect(Array.isArray(apps)).toBe(true);
    expect(apps.length).toBeGreaterThan(0);

    const before = await captureFrontAppSnapshot();
    expect(before?.appName).toBeTruthy();

    const result = await ensureNativeAppPriority("Finder", EVIDENCE_PATH);
    expect(result.ok).toBe(true);
    expect(result.blocker).toBeNull();
    expect(result.after?.bundleId || result.after?.appName).toBeTruthy();
    if (result.after?.bundleId) {
      expect(result.after.bundleId).toBe("com.apple.finder");
    }

    const raw = await readFile(EVIDENCE_PATH, "utf-8");
    const evidence = JSON.parse(raw);
    expect(evidence.ok).toBe(true);
    expect(evidence.requestedApp).toBe("Finder");
    expect(evidence.after.bundleId || evidence.after.appName).toBeTruthy();
  });
});
