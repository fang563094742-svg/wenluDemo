import express from "express";
import { buildAdminJsRouter } from "./adminjs.js";
import { loadAdminConfig } from "./config.js";

export async function createAdminApp(): Promise<express.Application> {
  const config = loadAdminConfig();
  const app = express();

  app.disable("x-powered-by");
  app.use(express.json({ limit: "256kb" }));

  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      message: "管理后台服务正常",
      service: "问路后台",
      mountPath: config.rootPath,
      adminJsEnabled: config.enableAdminJs,
      customAdminEnabled: true,
    });
  });

  app.get("/", (_req, res) => {
    res.redirect(config.rootPath);
  });

  const adminRouter = await buildAdminJsRouter(config);
  app.use(config.rootPath, adminRouter);

  app.use((_req, res) => {
    res.status(404).json({ error: "页面不存在" });
  });

  return app;
}
