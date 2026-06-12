/**
 * 问路 — 多用户 API 服务入口（Express）。
 *
 * 与原有的原生 Node http demo 服务并存。
 * 该 app 负责：认证、付费、分享、多用户 mind/聊天 API。
 */

import express from "express";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { authRouter } from "../auth/routes.js";
import { capabilityRouter } from "../capability-pool/routes.js";
import { createRefluxRouters } from "../reflux/routes.js";

const paymentConfigPath = resolve(process.cwd(), "data/payment-config.json");

async function loadPaymentConfig() {
  const raw = await readFile(paymentConfigPath, "utf-8");
  return JSON.parse(raw);
}

export function createApp(): express.Application {
  const app = express();

  // ── 全局中间件 ──────────────────────────────────────────────────────────
  app.use(express.json({ limit: "1mb" }));

  // CORS（开发期间全开，生产应按域名限制）
  app.use((_req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    if (_req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // ── 路由挂载 ────────────────────────────────────────────────────────────
  app.use("/api/auth", authRouter);
  app.use("/api/capabilities", capabilityRouter);

  // 技能反哺（skill-reflux）路由：/api/skills（list/expand/inherit/mine）、
  // /api/reflux（onboard/stats/pending），整体经 requireAuth，pending 额外经 requireAdmin。
  const { skillRouter, refluxRouter } = createRefluxRouters();
  app.use("/api/skills", skillRouter);
  app.use("/api/reflux", refluxRouter);

  app.get("/api/payment-options", async (_req, res) => {
    try {
      const config = await loadPaymentConfig();
      res.json({
        status: "ok",
        options: {
          direct: {
            preferredLabel: config.direct?.preferredLabel,
            remarkTemplate: config.direct?.remarkTemplate,
            methods: (config.direct?.methods ?? []).map((method: { label?: string; note?: string }) => ({
              label: method.label,
              note: method.note,
            })),
          },
          crypto: {
            trigger: config.binance?.copywriting?.trigger,
            shortReply: config.binance?.copywriting?.shortReply,
            riskReply: config.binance?.copywriting?.riskReply,
          },
          confirmation: config.confirmation,
        },
      });
    } catch (error) {
      res.status(500).json({
        status: "error",
        message: error instanceof Error ? error.message : "payment config unavailable",
      });
    }
  });

  // ── 健康检查 ────────────────────────────────────────────────────────────
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", service: "wenlu-api" });
  });

  // ── 404 兜底 ────────────────────────────────────────────────────────────
  app.use((_req, res) => {
    res.status(404).json({ error: "Not Found" });
  });

  return app;
}
