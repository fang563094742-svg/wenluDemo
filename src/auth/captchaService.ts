import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, constants as fsConstants } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const HELPER_DIR = resolve(process.cwd(), "playground/go-captcha-helper");
const HELPER_BIN = resolve(HELPER_DIR, "wenlu-go-captcha-helper");

const CAPTCHA_TTL_MS = readPositiveInt(process.env.AUTH_CAPTCHA_TTL_MS, 2 * 60 * 1000);
const CAPTCHA_TICKET_TTL_MS = readPositiveInt(process.env.AUTH_CAPTCHA_TICKET_TTL_MS, 10 * 60 * 1000);
const CAPTCHA_VERIFY_PADDING = readPositiveInt(process.env.AUTH_CAPTCHA_VERIFY_PADDING, 5);

type CaptchaMode = "slide";

interface GoCaptchaHelperResult {
  image_base64: string;
  tile_base64: string;
  tile_width: number;
  tile_height: number;
  // go-captcha slide.Block.DX / DY: initial display position of the draggable tile.
  tile_x: number;
  tile_y: number;
  // go-captcha slide.Block.X / Y: actual target position of the hole on the master image.
  target_x: number;
  target_y: number;
}

interface CaptchaChallengeState {
  key: string;
  scene: string;
  mode: CaptchaMode;
  imageBase64: string;
  tileBase64: string;
  tileWidth: number;
  tileHeight: number;
  tileX: number;
  tileY: number;
  targetX: number;
  targetY: number;
  expiresAt: number;
  used: boolean;
}

interface CaptchaTicketState {
  ticket: string;
  scene: string;
  verifiedAt: string;
  expiresAt: number;
  consumed: boolean;
}

export interface CaptchaClientConfig {
  enabled: boolean;
  provider: "go-captcha";
  type: CaptchaMode;
  scene: string;
  captchaId: string;
  scriptUrl: string;
  styleUrl: string;
  dataApi: string;
  verifyApi: string;
  width: number;
  height: number;
  submitMode: "auto";
}

export interface CaptchaChallengePayload {
  captcha_key: string;
  image_base64: string;
  tile_base64: string;
  tile_width: number;
  tile_height: number;
  tile_x: number;
  tile_y: number;
}

export interface CaptchaVerifyResult {
  ok: boolean;
  message: string;
  ticket?: string;
  verifiedAt?: string;
}

export interface CaptchaChallengeDebugState {
  key: string;
  scene: string;
  tileX: number;
  tileY: number;
  targetX: number;
  targetY: number;
  expiresAt: number;
  used: boolean;
}

const challengeStore = new Map<string, CaptchaChallengeState>();
const ticketStore = new Map<string, CaptchaTicketState>();

let helperReadyPromise: Promise<void> | null = null;

function readPositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeScene(scene: string | null | undefined): string {
  return (scene ?? "").trim() || "login";
}

function pruneExpiredState() {
  const now = Date.now();
  for (const [key, value] of challengeStore.entries()) {
    if (value.expiresAt <= now || value.used) {
      challengeStore.delete(key);
    }
  }
  for (const [key, value] of ticketStore.entries()) {
    if (value.expiresAt <= now || value.consumed) {
      ticketStore.delete(key);
    }
  }
}

const pruneTimer = setInterval(pruneExpiredState, 30_000);
pruneTimer.unref();

/**
 * 验证码总开关（惰性读取）。
 *
 * 关键：必须在「用到时」才读 process.env，而不是模块加载期读成 const——
 * 因为本模块在 ESM import 阶段就被加载，早于 riverMain 在模块体里加载 `.env`，
 * 若在加载期读常量，`.env` 里的 AUTH_CAPTCHA_ENABLED 永远来不及生效（历史坑）。
 * 惰性读取后：`.env` 的 `AUTH_CAPTCHA_ENABLED=false` 或启动 shell 环境变量都能正确关闭验证码。
 *
 * 取值：缺省 "true"（开）；显式 "false"/"0"/"off"/"no" 关闭，其余视为开。
 */
function captchaEnabled(): boolean {
  const v = (process.env.AUTH_CAPTCHA_ENABLED ?? "true").trim().toLowerCase();
  return !(v === "false" || v === "0" || v === "off" || v === "no");
}

function isCaptchaEnabledForScene(scene: string): boolean {
  return captchaEnabled() && Boolean(scene);
}

async function ensureHelperBinary(): Promise<void> {
  if (helperReadyPromise) {
    return helperReadyPromise;
  }

  helperReadyPromise = (async () => {
    try {
      await access(HELPER_BIN, fsConstants.X_OK);
      return;
    } catch {
      await execFileAsync("go", ["-C", HELPER_DIR, "build", "-o", HELPER_BIN, "./..."], {
        cwd: process.cwd(),
        timeout: 60_000,
        maxBuffer: 8 * 1024 * 1024,
      });
    }
  })();

  try {
    await helperReadyPromise;
  } finally {
    helperReadyPromise = null;
  }
}

function assertHelperPayload(payload: unknown): GoCaptchaHelperResult {
  if (!payload || typeof payload !== "object") {
    throw new Error("GO_CAPTCHA_PAYLOAD_INVALID");
  }
  const helper = payload as Partial<GoCaptchaHelperResult>;
  if (
    !helper.image_base64 ||
    !helper.tile_base64 ||
    !Number.isFinite(helper.tile_width) ||
    !Number.isFinite(helper.tile_height) ||
    !Number.isFinite(helper.tile_x) ||
    !Number.isFinite(helper.tile_y) ||
    !Number.isFinite(helper.target_x) ||
    !Number.isFinite(helper.target_y)
  ) {
    throw new Error("GO_CAPTCHA_PAYLOAD_INCOMPLETE");
  }
  return helper as GoCaptchaHelperResult;
}

function parsePoint(raw: string): { x: number; y: number } | null {
  const normalized = raw.trim();
  if (!normalized) {
    return null;
  }
  const [xRaw, yRaw] = normalized.split(",", 2);
  const x = Number.parseInt((xRaw ?? "").trim(), 10);
  const y = Number.parseInt((yRaw ?? "").trim(), 10);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }
  return { x, y };
}

function validateSlidePoint(sx: number, sy: number, dx: number, dy: number, padding: number): boolean {
  const minX = dx - padding;
  const maxX = dx + padding;
  const minY = dy - padding;
  const maxY = dy + padding;
  return sx >= minX && sx <= maxX && sy >= minY && sy <= maxY;
}

function resolveSlideVerifyCandidates(
  point: { x: number; y: number },
  challenge: Pick<CaptchaChallengeState, "tileX" | "tileY" | "targetY">,
): Array<{ x: number; y: number }> {
  const candidates = new Map<string, { x: number; y: number }>();

  const pushCandidate = (x: number, y: number) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return;
    }
    candidates.set(`${x},${y}`, { x, y });
  };

  pushCandidate(point.x, point.y);
  pushCandidate(point.x + challenge.tileX, point.y);
  pushCandidate(point.x, point.y + challenge.tileY);
  pushCandidate(point.x + challenge.tileX, point.y + challenge.tileY);

  if (Math.abs(point.y - challenge.tileY) <= CAPTCHA_VERIFY_PADDING * 2) {
    pushCandidate(point.x, challenge.targetY);
    pushCandidate(point.x + challenge.tileX, challenge.targetY);
  }

  return [...candidates.values()];
}

export function getCaptchaClientConfig(sceneInput: string | null | undefined): CaptchaClientConfig {
  const scene = normalizeScene(sceneInput);
  const enabled = isCaptchaEnabledForScene(scene);
  return {
    enabled,
    provider: "go-captcha",
    type: "slide",
    scene,
    captchaId: `${scene}-slide`,
    scriptUrl: "/vendor/go-captcha/gocaptcha.global.js",
    styleUrl: "/vendor/go-captcha/gocaptcha.global.css",
    dataApi: `/api/auth/captcha/data?scene=${encodeURIComponent(scene)}`,
    verifyApi: "/api/auth/captcha/verify",
    width: 300,
    height: 220,
    submitMode: "auto",
  };
}

export async function createCaptchaChallenge(sceneInput: string | null | undefined): Promise<CaptchaChallengePayload> {
  pruneExpiredState();
  const scene = normalizeScene(sceneInput);
  if (!isCaptchaEnabledForScene(scene)) {
    throw new Error("CAPTCHA_DISABLED");
  }

  await ensureHelperBinary();
  const { stdout } = await execFileAsync(HELPER_BIN, ["generate-slide"], {
    cwd: HELPER_DIR,
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
  });

  const parsed = assertHelperPayload(JSON.parse(stdout.trim()));
  const key = randomUUID();

  challengeStore.set(key, {
    key,
    scene,
    mode: "slide",
    imageBase64: parsed.image_base64,
    tileBase64: parsed.tile_base64,
    tileWidth: parsed.tile_width,
    tileHeight: parsed.tile_height,
    tileX: parsed.tile_x,
    tileY: parsed.tile_y,
    targetX: parsed.target_x,
    targetY: parsed.target_y,
    expiresAt: Date.now() + CAPTCHA_TTL_MS,
    used: false,
  });

  return {
    captcha_key: key,
    image_base64: parsed.image_base64,
    tile_base64: parsed.tile_base64,
    tile_width: parsed.tile_width,
    tile_height: parsed.tile_height,
    tile_x: parsed.tile_x,
    tile_y: parsed.tile_y,
  };
}

export function verifyCaptchaChallenge(input: {
  scene: string | null | undefined;
  key: string | null | undefined;
  value: string | null | undefined;
}): CaptchaVerifyResult {
  pruneExpiredState();
  const scene = normalizeScene(input.scene);
  const key = (input.key ?? "").trim();
  const value = (input.value ?? "").trim();

  if (!key || !value) {
    return { ok: false, message: "缺少验证码校验参数" };
  }

  const challenge = challengeStore.get(key);
  if (!challenge || challenge.used || challenge.scene !== scene || challenge.expiresAt <= Date.now()) {
    challengeStore.delete(key);
    return { ok: false, message: "验证码已失效，请刷新后重试" };
  }

  const point = parsePoint(value);
  if (!point) {
    return { ok: false, message: "验证码结果格式不正确，请重试" };
  }

  const matched = resolveSlideVerifyCandidates(point, challenge).some((candidate) =>
    validateSlidePoint(
      candidate.x,
      candidate.y,
      challenge.targetX,
      challenge.targetY,
      CAPTCHA_VERIFY_PADDING,
    ),
  );

  challenge.used = true;
  challengeStore.delete(key);

  if (!matched) {
    return { ok: false, message: "验证码校验失败，请重试" };
  }

  const ticket = randomUUID();
  const verifiedAt = new Date().toISOString();
  ticketStore.set(ticket, {
    ticket,
    scene,
    verifiedAt,
    expiresAt: Date.now() + CAPTCHA_TICKET_TTL_MS,
    consumed: false,
  });

  return {
    ok: true,
    message: "ok",
    ticket,
    verifiedAt,
  };
}

export function getCaptchaChallengeDebugState(keyInput: string | null | undefined): CaptchaChallengeDebugState | null {
  const key = (keyInput ?? "").trim();
  if (!key) {
    return null;
  }

  pruneExpiredState();
  const challenge = challengeStore.get(key);
  if (!challenge) {
    return null;
  }

  return {
    key: challenge.key,
    scene: challenge.scene,
    tileX: challenge.tileX,
    tileY: challenge.tileY,
    targetX: challenge.targetX,
    targetY: challenge.targetY,
    expiresAt: challenge.expiresAt,
    used: challenge.used,
  };
}

export function consumeCaptchaTicket(sceneInput: string | null | undefined, ticketInput: string | null | undefined): CaptchaVerifyResult {
  pruneExpiredState();
  const scene = normalizeScene(sceneInput);
  const ticket = (ticketInput ?? "").trim();

  if (!ticket) {
    return { ok: false, message: "缺少验证码校验参数" };
  }

  const entry = ticketStore.get(ticket);
  if (!entry || entry.consumed || entry.expiresAt <= Date.now()) {
    ticketStore.delete(ticket);
    return { ok: false, message: "验证码已过期，请重新完成验证" };
  }
  if (entry.scene !== scene) {
    return { ok: false, message: "验证码场景不匹配，请重新验证" };
  }

  entry.consumed = true;
  ticketStore.delete(ticket);

  return {
    ok: true,
    message: "ok",
    ticket: entry.ticket,
    verifiedAt: entry.verifiedAt,
  };
}
