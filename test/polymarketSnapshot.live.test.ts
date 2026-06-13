import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(__dirname, "..");
const snapshotScript = path.join(projectRoot, "scripts", "polymarketSnapshot.ts");
const verifyScript = path.join(projectRoot, "scripts", "polymarketSnapshotVerify.ts");

describe("polymarket snapshot live verification", () => {
  it("captures live markets and verifies against the API", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wenlu-polymarket-"));
    const outputPath = path.join(tempDir, "markets_snapshot.json");

    try {
      await execFileAsync(
        process.execPath,
        ["--import", "tsx", snapshotScript],
        {
          cwd: projectRoot,
          env: {
            ...process.env,
            POLYMARKET_LIMIT: "2",
            POLYMARKET_SNAPSHOT_OUT: outputPath,
          },
          timeout: 30000,
        },
      );

      const snapshotRaw = await readFile(outputPath, "utf8");
      const snapshot = JSON.parse(snapshotRaw) as {
        ok: boolean;
        source: string;
        marketCount: number;
        entries: unknown[];
      };

      expect(snapshot.ok).toBe(true);
      expect(snapshot.source).toContain("polymarket.com/markets");
      expect(snapshot.marketCount).toBe(2);
      expect(Array.isArray(snapshot.entries)).toBe(true);
      expect(snapshot.entries).toHaveLength(2);

      const verifyResult = await execFileAsync(
        process.execPath,
        ["--import", "tsx", verifyScript],
        {
          cwd: projectRoot,
          env: {
            ...process.env,
            POLYMARKET_SNAPSHOT_OUT: outputPath,
          },
          timeout: 30000,
        },
      );

      const verifyPayload = JSON.parse(verifyResult.stdout) as { ok: boolean };
      expect(verifyPayload.ok).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 60000);
});
