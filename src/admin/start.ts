import { initSchema } from "../db/pool.js";
import { createAdminApp } from "./app.js";
import { loadAdminConfig } from "./config.js";

const config = loadAdminConfig();

await initSchema();

const app = await createAdminApp();

app.listen(config.port, config.host, () => {
  console.log(`[问路 Admin] 服务已启动 http://${config.host}:${config.port}${config.rootPath}`);
  console.log(`[问路 Admin] 健康检查 http://${config.host}:${config.port}/health`);
});
