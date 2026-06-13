/**
 * per-user-brain 方案 B 全链路验证脚本（可复用）。
 *
 * 用途：自动验证「网关 + 每用户独立进程」整条链路与跨用户隔离。
 * 模拟两个浏览器会话(同源 cookie) + 两个本地连接器(ws ?token)，全部经网关(默认3200)：
 *   注册 → /state(触发进程 spawn) → SSE /events → /ui-ready → /say → /history
 *   → 连接器上线 → /connector/status → 跨用户隔离断言（聊天/SSE/连接器互不串）。
 *
 * 前置：
 *   1. 共享平台后端在跑（默认 3210），且验证码已关（.env: AUTH_CAPTCHA_ENABLED=false）。
 *   2. 网关在跑：`npx tsx src/gateway/start.ts`（默认 3200）。
 * 运行：`node scripts/verifyPerUserGateway.mjs`
 * 退出码 0 = 全通过。脚本会创建并清理一次性测试用户（用户名前缀 e2e_）。
 *
 * 说明：不依赖 LLM 成功（聊天 reply 属 best-effort）；核心断言为「路由 + 隔离」。
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import http from "node:http";
import WebSocket from "ws";
import pg from "pg";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const env = {};
for (const line of readFileSync(resolve(ROOT, ".env"), "utf-8").split("\n")) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("="); if (i < 0) continue;
  let v = t.slice(i + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  env[t.slice(0, i).trim()] = v;
}
const GW = parseInt(env.WENLU_GATEWAY_PORT || "3200", 10);

const results = [];
function check(name, ok, detail) { results.push({ name, ok }); console.log(`${ok ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpReq(path, { method = "GET", token, cookie, bodyObj, timeoutMs = 90000 } = {}) {
  return new Promise((res) => {
    const headers = {};
    if (token) headers["authorization"] = "Bearer " + token;
    if (cookie) headers["cookie"] = cookie;
    let payload = null;
    if (bodyObj !== undefined) { payload = Buffer.from(JSON.stringify(bodyObj)); headers["content-type"] = "application/json"; headers["content-length"] = payload.length; }
    const r = http.request({ host: "127.0.0.1", port: GW, path, method, headers, timeout: timeoutMs }, (resp) => {
      let b = ""; resp.on("data", (d) => (b += d)); resp.on("end", () => res({ status: resp.statusCode, headers: resp.headers, body: b }));
    });
    r.on("error", (e) => res({ status: 0, body: String(e.message) }));
    r.on("timeout", () => { r.destroy(); res({ status: 0, body: "timeout" }); });
    if (payload) r.write(payload);
    r.end();
  });
}

async function register() {
  const suffix = randomBytes(4).toString("hex");
  const r = await httpReq("/api/auth/password/register", { method: "POST", bodyObj: { username: "e2e_" + suffix, password: "E2eFull_" + suffix + "!" }, timeoutMs: 30000 });
  if (r.status !== 201 && r.status !== 200) throw new Error(`注册失败 status=${r.status} body=${r.body.slice(0,200)}（验证码是否已关？）`);
  const d = JSON.parse(r.body);
  const token = d.accessToken || d.token || (d.data && (d.data.accessToken || d.data.token));
  const userId = (d.user && d.user.id) || (d.data && d.data.user && d.data.user.id);
  let cookie = "";
  for (const c of (r.headers["set-cookie"] || [])) { const m = /wenlu_access_token=([^;]+)/.exec(c); if (m) cookie = "wenlu_access_token=" + m[1]; }
  if (!token || !userId || !cookie) throw new Error("注册响应缺 token/userId/cookie");
  return { userId, token, cookie };
}

function openSSE(cookie, sink, timeoutMs = 60000) {
  return new Promise((resolveOpen) => {
    const req = http.request({ host: "127.0.0.1", port: GW, path: "/events", method: "GET", headers: { cookie, accept: "text/event-stream" } }, (resp) => {
      sink.status = resp.statusCode;
      if (resp.statusCode !== 200) { resp.resume(); resolveOpen({ close: () => req.destroy(), ok: false }); return; }
      let buf = "";
      resp.on("data", (d) => {
        buf += d.toString(); let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
          let ev = null, data = null;
          for (const line of chunk.split("\n")) { if (line.startsWith("event:")) ev = line.slice(6).trim(); else if (line.startsWith("data:")) data = line.slice(5).trim(); }
          if (data) { try { sink.events.push({ ev, data: JSON.parse(data) }); } catch { sink.events.push({ ev, raw: data }); } }
        }
      });
      resolveOpen({ close: () => req.destroy(), ok: true });
    });
    req.on("error", () => resolveOpen({ close: () => {}, ok: false }));
    req.end();
    setTimeout(() => resolveOpen({ close: () => req.destroy(), ok: sink.status === 200 }), timeoutMs);
  });
}

function connectConnector(token, label) {
  return new Promise((resolveC) => {
    const ws = new WebSocket(`ws://127.0.0.1:${GW}/connector/ws?token=${encodeURIComponent(token)}`);
    const state = { online: false, gotCmd: 0, ws };
    ws.on("open", () => { ws.send(JSON.stringify({ type: "hello", platform: "win32", arch: "x64", version: "e2e", machineLabel: label, folders: {} })); state.online = true; resolveC(state); });
    ws.on("message", (raw) => { let m; try { m = JSON.parse(raw.toString()); } catch { return; } if (m.type === "ping") ws.send(JSON.stringify({ type: "pong" })); else if (m.type === "cmd") { state.gotCmd++; ws.send(JSON.stringify({ type: "result", id: m.id, ok: true, data: { echoed: m.op, by: label } })); } });
    ws.on("error", () => { if (!state.online) resolveC(state); });
    setTimeout(() => resolveC(state), 8000);
  });
}

async function main() {
  console.log(`网关=${GW}`);
  let A, B;
  try { A = await register(); B = await register(); check("两用户经网关注册成功(captcha 已关)", true, `A=${A.userId.slice(0,8)} B=${B.userId.slice(0,8)}`); }
  catch (e) { check("两用户经网关注册成功", false, e.message); return finish(); }

  check("A /state(cookie) 200 触发其进程", (await httpReq("/state", { cookie: A.cookie })).status === 200);
  check("B /state(cookie) 200 触发其进程", (await httpReq("/state", { cookie: B.cookie })).status === 200);

  const health = JSON.parse((await httpReq("/gw/health")).body || "{}");
  const pa = (health.procs || []).find((p) => p.userId === A.userId);
  const pb = (health.procs || []).find((p) => p.userId === B.userId);
  check("网关为两用户各拉起独立进程且端口不同", !!(pa && pb && pa.port !== pb.port), pa && pb ? `A=${pa.port} B=${pb.port}` : "缺进程");

  const sinkA = { events: [] }, sinkB = { events: [] };
  const sseA = await openSSE(A.cookie, sinkA); const sseB = await openSSE(B.cookie, sinkB);
  check("A SSE /events(cookie) 建立", sseA.ok); check("B SSE /events(cookie) 建立", sseB.ok);
  await httpReq("/ui-ready", { method: "POST", cookie: A.cookie }); await httpReq("/ui-ready", { method: "POST", cookie: B.cookie });

  const msgA = "e2e-A-" + randomBytes(3).toString("hex"); const msgB = "e2e-B-" + randomBytes(3).toString("hex");
  check("A /say 200", (await httpReq("/say", { method: "POST", cookie: A.cookie, bodyObj: { text: msgA } })).status === 200);
  check("B /say 200", (await httpReq("/say", { method: "POST", cookie: B.cookie, bodyObj: { text: msgB } })).status === 200);
  await sleep(4000);

  const histA = (await httpReq("/history?channelId=chat_default", { cookie: A.cookie })).body;
  const histB = (await httpReq("/history?channelId=chat_default", { cookie: B.cookie })).body;
  check("A /history 含自己的消息", histA.includes(msgA));
  check("A /history 不含 B 的消息(隔离)", !histA.includes(msgB));
  check("B /history 含自己的消息", histB.includes(msgB));
  check("B /history 不含 A 的消息(隔离)", !histB.includes(msgA));

  check("A SSE 收到自己的消息事件", sinkA.events.some((e) => JSON.stringify(e.data).includes(msgA)), `A事件数=${sinkA.events.length}`);
  check("A SSE 未收到 B 的消息事件(隔离)", !sinkA.events.some((e) => JSON.stringify(e.data).includes(msgB)));

  const connA = await connectConnector(A.token, "connA");
  check("连接器A 经网关 ?token 连上", connA.online);
  await sleep(1500);
  const statA1 = JSON.parse((await httpReq("/connector/status", { cookie: A.cookie })).body || "{}");
  const statB1 = JSON.parse((await httpReq("/connector/status", { cookie: B.cookie })).body || "{}");
  check("仅连A时：A /connector/status online=true", statA1.online === true);
  check("仅连A时：B /connector/status online=false(隔离)", statB1.online === false);

  const connB = await connectConnector(B.token, "connB");
  check("连接器B 经网关 ?token 连上", connB.online);
  await sleep(1500);
  check("连B后：B /connector/status online=true", JSON.parse((await httpReq("/connector/status", { cookie: B.cookie })).body || "{}").online === true);

  try { sseA.close(); sseB.close(); connA.ws?.close(); connB.ws?.close(); } catch {}
  await finish([A.userId, B.userId]);
}

async function finish(userIds) {
  if (userIds && userIds.length) {
    try {
      const pool = new pg.Pool({ host: env.WENLU_DB_HOST || "127.0.0.1", port: parseInt(env.WENLU_DB_PORT || "5432", 10), database: env.WENLU_DB_NAME || "wenlu", user: env.WENLU_DB_USER || "wenlu", password: env.WENLU_DB_PASSWORD });
      const tbls = await pool.query(`SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='user_id'`);
      for (let p = 0; p < 3; p++) for (const t of tbls.rows.map(x => x.table_name)) { try { await pool.query(`DELETE FROM "${t}" WHERE user_id = ANY($1::uuid[])`, [userIds]); } catch {} }
      const du = await pool.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [userIds]);
      check("清理测试用户", du.rowCount === userIds.length, `删除 users=${du.rowCount}`);
      await pool.end();
    } catch (e) { check("清理测试用户", false, e.message); }
  }
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n===== 结果：${passed}/${results.length} 通过 =====`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => { console.error("harness 异常", e); finish(); });
