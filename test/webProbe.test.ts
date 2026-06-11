import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { probeUrl } from "../scripts/webProbe.js";

describe("probeUrl", () => {
  let server: Server;
  let baseUrl = "";

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/redirect") {
        res.statusCode = 302;
        res.setHeader("location", "/final");
        res.end();
        return;
      }
      if (req.url === "/final") {
        res.statusCode = 200;
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end("<html><head><title>Probe Final</title></head><body>Hello Keyword</body></html>");
        return;
      }
      res.statusCode = 404;
      res.end("missing");
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to get test server address");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  });

  it("follows redirects and extracts title + keyword", async () => {
    const result = await probeUrl(`${baseUrl}/redirect`, "keyword");
    expect(result.error).toBeNull();
    expect(result.status).toBe(200);
    expect(result.finalUrl).toBe(`${baseUrl}/final`);
    expect(result.title).toBe("Probe Final");
    expect(result.keywordFound).toBe(true);
  });

  it("returns error payload for unreachable host", async () => {
    const result = await probeUrl("http://127.0.0.1:9/unreachable", "x");
    expect(result.status).toBe(0);
    expect(result.error).toBeTruthy();
    expect(result.keywordFound).toBe(false);
  });
});
