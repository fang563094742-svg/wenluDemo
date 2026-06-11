/**
 * 问路 — 多用户 API 服务入口（Express）。
 *
 * 与原有的原生 Node http demo 服务并存。
 * 该 app 负责：认证、付费、分享、多用户 mind/聊天 API。
 */

import express from "express";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { authRouter } from "../auth/routes.js";
import { capabilityRouter } from "../capability-pool/routes.js";

const paymentConfigPath = resolve(process.cwd(), "data/payment-config.json");
const execFileAsync = promisify(execFile);

async function loadPaymentConfig() {
  const raw = await readFile(paymentConfigPath, "utf-8");
  return JSON.parse(raw);
}

async function canExecute(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function readJsonIfExists(targetPath: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(targetPath, "utf-8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function helpResponds(binaryPath: string): Promise<boolean> {
  try {
    await execFileAsync(binaryPath, ["--help"], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

export function createApp(): express.Application {
  const app = express();

  app.use(express.json({ limit: "1mb" }));

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

  app.use("/api/auth", authRouter);
  app.use("/api/capabilities", capabilityRouter);

  app.get("/api/integrations/kiro-cc/status", async (_req, res) => {
    try {
      const kiroBin = process.env.KIRO_BIN || "/usr/local/bin/kiro";
      const ccSwitchBin = process.env.CC_SWITCH_BIN || "/Applications/CC Switch.app/Contents/MacOS/cc-switch";
      const ccAppPaths = resolve(homedir(), "Library/Application Support/com.ccswitch.desktop/app_paths.json");

      const kiroCliAvailable = await canExecute(kiroBin);
      const ccSwitchCliAvailable = await canExecute(ccSwitchBin);
      const ccConfiguredApps = (await readJsonIfExists(ccAppPaths)) ?? {};

      res.json({
        status: "ok",
        integration: "kiro-cc",
        readyForCcBinding: kiroCliAvailable && ccSwitchCliAvailable,
        kiro: {
          bin: kiroBin,
          cliAvailable: kiroCliAvailable,
          helpResponds: kiroCliAvailable ? await helpResponds(kiroBin) : false,
        },
        ccSwitch: {
          bin: ccSwitchBin,
          cliAvailable: ccSwitchCliAvailable,
          helpResponds: ccSwitchCliAvailable ? await helpResponds(ccSwitchBin) : false,
          configuredAppsCount: Object.keys(ccConfiguredApps).length,
          configuredApps: ccConfiguredApps,
        },
        nextStep:
          Object.keys(ccConfiguredApps).length === 0
            ? "CC Switch still needs an app mapping before a direct Kiro binding can be executed."
            : "CC Switch has app mappings; next step is to add or verify the Kiro target mapping.",
      });
    } catch (error) {
      res.status(500).json({
        status: "error",
        message: error instanceof Error ? error.message : "kiro-cc status unavailable",
      });
    }
  });

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

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", service: "wenlu-api" });
  });

  app.use((_req, res) => {
    res.status(404).json({ error: "Not Found" });
  });

  return app;
}
