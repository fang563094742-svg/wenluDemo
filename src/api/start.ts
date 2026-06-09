/**
 * 问路 — 多用户 API 服务启动入口。
 *
 * 独立于原有的单用户 demo 服务器（riverMain → webServer），
 * 监听在不同端口上，为 iOS/移动端提供 REST API。
 *
 * 启动方式：
 *   npx tsx src/api/start.ts
 * 或在 package.json scripts 中：
 *   "api": "tsx src/api/start.ts"
 */

import { createApp } from "./app.js";

const PORT = parseInt(process.env.API_PORT || "3721", 10);
const HOST = process.env.API_HOST || "0.0.0.0"; // API 服务对外可达

const app = createApp();

app.listen(PORT, HOST, () => {
  console.log(`[问路 API] 服务已启动 http://${HOST}:${PORT}`);
  console.log(`[问路 API] 健康检查 http://${HOST}:${PORT}/api/health`);
});
