/**
 * 独立性静态断言 + barrel 契约 — Property 10（最高约束·不可跳过）
 * Validates: Requirements 9.1
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as CH from "../index.js";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(here, "..");

function listTs(dir: string): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === "__tests__") continue;
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...listTs(p));
    else if (ent.name.endsWith(".ts")) out.push(p);
  }
  return out;
}
function strip(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}
function imports(code: string): string[] {
  const out: string[] = [];
  const re = /(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) out.push(m[1]);
  return out;
}

describe("channels 独立性静态断言 (Property 10, Req 9.1)", () => {
  const files = listTs(srcDir);
  it("能扫到源码文件", () => {
    expect(files.length).toBeGreaterThanOrEqual(7);
  });
  it("无禁用 import、不反向 import riverMain、仅相对(.js)/node:crypto", () => {
    for (const f of files) {
      const code = strip(readFileSync(f, "utf8"));
      expect(/3\.1后端|3\.2后端|\/3\.2\//.test(code), `${f} 含 3.1/3.2`).toBe(false);
      expect(/["']server-only["']/.test(code), `${f} server-only`).toBe(false);
      expect(/["']node:sqlite["']/.test(code), `${f} node:sqlite`).toBe(false);
      expect(/["']@\/lib/.test(code), `${f} @/lib`).toBe(false);
      expect(/riverMain/.test(code), `${f} 反向 import riverMain`).toBe(false);
      for (const src of imports(code)) {
        const ok = src === "node:crypto" || (src.startsWith(".") && src.endsWith(".js"));
        expect(ok, `${f} 非法 import: ${src}`).toBe(true);
      }
    }
  });
});

describe("channels barrel 契约 (Req 9.1)", () => {
  it("导出预期公共符号", () => {
    for (const n of [
      "CHANNELS_SCHEMA_VERSION", "DECISIONS_CHANNEL_ID", "NOTIFICATIONS_CHANNEL_ID", "DEFAULT_USER_CHANNEL_ID",
      "newMessageId", "newChannelId", "newDecisionId",
      "SYSTEM_CHANNELS", "defaultUserChannel", "ensureSystemChannels",
      "emptyChannels", "getChannel", "addUserChannel", "renameChannel", "archiveChannel", "appendMessage",
      "enqueueDecision", "resolveDecision", "pendingCount", "pendingForChannel",
      "unreadMessages", "unreadCount", "advanceCursor", "markChannelRead", "decisionsBadge",
      "routeMessage", "buildReplyContext", "migrateLegacyConversation",
    ]) {
      expect((CH as Record<string, unknown>)[n], n).toBeDefined();
    }
  });
});
