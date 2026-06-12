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
import { paymentRouter } from "./paymentRoutes.js";
import { loadLdxpConfig, LdxpMerchantClient } from "../pay/ldxpClient.js";
import { startAutoReconcileLoop } from "../pay/reconcileService.js";

const paymentConfigPath = resolve(process.cwd(), "data/payment-config.json");

async function loadPaymentConfig() {
  const raw = await readFile(paymentConfigPath, "utf-8");
  return JSON.parse(raw);
}

export function createApp(): express.Application {
  const app = express();
  startAutoReconcileLoop();
  const allowCredentials = (process.env.CORS_ALLOW_CREDENTIALS ?? "true") !== "false";
  const configuredOrigin = process.env.CORS_ORIGIN?.trim();

  // ── 全局中间件 ──────────────────────────────────────────────────────────
  app.use(express.json({ limit: "1mb" }));

  // CORS（开发期间全开，生产应按域名限制）
  app.use((req, res, next) => {
    const requestOrigin = req.headers.origin;
    const allowOrigin = configuredOrigin || requestOrigin || "*";
    res.header("Access-Control-Allow-Origin", allowOrigin);
    res.header("Vary", "Origin");
    if (allowCredentials) {
      res.header("Access-Control-Allow-Credentials", "true");
    }
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // ── 路由挂载 ────────────────────────────────────────────────────────────
  app.use("/api/auth", authRouter);
  app.use("/api/capabilities", capabilityRouter);
  app.use("/api/payments", paymentRouter);

  // 技能反哺（skill-reflux）路由：/api/skills（list/expand/inherit/mine）、
  // /api/reflux（onboard/stats/pending），整体经 requireAuth，pending 额外经 requireAdmin。
  const { skillRouter, refluxRouter } = createRefluxRouters();
  app.use("/api/skills", skillRouter);
  app.use("/api/reflux", refluxRouter);

  app.get("/api/payment-options", async (_req, res) => {
    try {
      const config = await loadPaymentConfig();
      const ldxpClient = new LdxpMerchantClient(loadLdxpConfig());
      const checkout = ldxpClient.getCheckoutInfo();
      res.json({
        status: "ok",
        options: {
          direct: {
            preferredLabel: config.direct?.preferredLabel || "链动小铺支付宝扫码",
            remarkTemplate: "下单后请在支付页填写联系方式：{clientReference}",
            methods: [
              {
                label: "支付宝扫码支付",
                note: `打开支付页 ${checkout.shopUrl}，填写联系方式后完成付款。`,
              },
              ...(config.direct?.methods ?? []).map((method: { label?: string; note?: string }) => ({
                label: method.label,
                note: method.note,
              })),
            ],
          },
          crypto: {
            trigger: config.binance?.copywriting?.trigger,
            shortReply: config.binance?.copywriting?.shortReply,
            riskReply: config.binance?.copywriting?.riskReply,
          },
          confirmation: config.confirmation,
          merchant: {
            provider: "ldxp",
            shopUrl: checkout.shopUrl,
            shopTitle: checkout.shopTitle,
            goodsName: checkout.goodsName,
            goodsAmountCents: checkout.goodsAmountCents,
            supportContact: checkout.supportContact,
            autoReconcileWindowHours: checkout.autoReconcileWindowHours,
          },
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
