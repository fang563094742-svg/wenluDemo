import { createHash, randomBytes } from "node:crypto";

const DEFAULT_GEETEST_ID = "9f8a0fa4cde13cb807ff62243dc52733";
const DEFAULT_GEETEST_KEY = "25cfce6aee7834c00d939a25c5f44ca5";
const DEFAULT_GEETEST_API_SERVER = "https://api.geetest.com";
const DEFAULT_GEETEST_CLIENT_API_SERVER = "api.geevisit.com";
const GEETEST_JS_URL = "https://static.geetest.com/static/js/gt.0.5.0.js";
const SDK_ID = "node-express:wenlu-auth";

type GeeTestRegisterApiResponse = {
  success?: number;
  new_captcha?: boolean;
  challenge?: string;
};

type GeeTestValidateApiResponse = {
  seccode?: string;
  result?: string;
  version?: string;
  message?: string;
  msg?: string;
};

type IssuedChallengeRecord = {
  success: 0 | 1;
  issuedAt: number;
};

export interface GeeTestRegisterPayload {
  success: 0 | 1;
  new_captcha: boolean;
  challenge: string;
  gt: string;
}

export interface GeeTestValidationPayload {
  geetestChallenge: string;
  geetestValidate: string;
  geetestSeccode: string;
}

export interface GeeTestValidationResult {
  success: boolean;
  reason: string;
  raw?: GeeTestValidateApiResponse;
}

export interface GeeTestRegisterOptions {
  clientType?: "web" | "h5" | "native" | "unknown";
  userId?: string;
  ipAddress?: string;
}

export interface GeeTestValidateOptions extends GeeTestRegisterOptions {}

const issuedChallenges = new Map<string, IssuedChallengeRecord>();
const ISSUED_CHALLENGE_TTL_MS = 10 * 60 * 1000;

function md5(input: string): string {
  return createHash("md5").update(input).digest("hex");
}

function rememberIssuedChallenge(challenge: string, success: 0 | 1): void {
  const now = Date.now();
  for (const [key, value] of issuedChallenges) {
    if (now - value.issuedAt > ISSUED_CHALLENGE_TTL_MS) {
      issuedChallenges.delete(key);
    }
  }
  issuedChallenges.set(challenge, {
    success,
    issuedAt: now,
  });
}

function buildLocalFailbackRegisterPayload(captchaId: string): GeeTestRegisterPayload {
  const challenge = randomBytes(16).toString("hex");
  rememberIssuedChallenge(challenge, 0);
  return {
    success: 0,
    new_captcha: true,
    gt: captchaId,
    challenge,
  };
}

function isFalseLike(value: string | null): boolean {
  return value !== null && value.trim().toLowerCase() === "false";
}

export function getGeeTestConfig() {
  const captchaId = process.env.GEETEST_CAPTCHA_ID ?? process.env.GEETEST_ID ?? DEFAULT_GEETEST_ID;
  const captchaKey = process.env.GEETEST_CAPTCHA_KEY ?? process.env.GEETEST_KEY ?? DEFAULT_GEETEST_KEY;
  const apiServer = (process.env.GEETEST_API_SERVER ?? DEFAULT_GEETEST_API_SERVER).replace(/\/$/, "");
  const enabled = (process.env.GEETEST_ENABLED ?? "true") !== "false";

  return {
    enabled,
    captchaId,
    captchaKey,
    apiServer,
    scriptUrl: GEETEST_JS_URL,
  };
}

export function getGeeTestClientConfig() {
  const { enabled, captchaId, scriptUrl } = getGeeTestConfig();
  return {
    enabled,
    success: 1,
    gt: captchaId,
    captchaId,
    scriptUrl,
    api_server: DEFAULT_GEETEST_CLIENT_API_SERVER,
    new_captcha: true,
  };
}

export async function registerGeeTest(
  opts: GeeTestRegisterOptions = {},
): Promise<GeeTestRegisterPayload> {
  const { enabled, captchaId, captchaKey, apiServer } = getGeeTestConfig();
  if (!enabled) {
    throw new Error("GEETEST_DISABLED");
  }

  const query = new URLSearchParams({
    gt: captchaId,
    digestmod: "md5",
    json_format: "1",
    sdk: SDK_ID,
    client_type: opts.clientType ?? "web",
  });
  if (opts.userId) query.set("user_id", opts.userId);
  if (opts.ipAddress) query.set("ip_address", opts.ipAddress);

  try {
    const response = await fetch(`${apiServer}/register.php?${query.toString()}`, {
      method: "GET",
    });
    if (!response.ok) {
      return buildLocalFailbackRegisterPayload(captchaId);
    }

    const data = (await response.json()) as GeeTestRegisterApiResponse;
    const rawChallenge = firstString(data.challenge);
    if (!rawChallenge || rawChallenge === "0") {
      return buildLocalFailbackRegisterPayload(captchaId);
    }

    const success = data.success === 0 ? 0 : 1;
    const challenge = success === 0 ? rawChallenge : md5(rawChallenge + captchaKey);
    rememberIssuedChallenge(challenge, success);

    return {
      success,
      new_captcha: data.new_captcha !== false,
      gt: captchaId,
      challenge,
    };
  } catch {
    return buildLocalFailbackRegisterPayload(captchaId);
  }
}

export function parseGeeTestPayload(input: unknown): GeeTestValidationPayload | null {
  if (!input || typeof input !== "object") {
    return null;
  }

  const record = input as Record<string, unknown>;
  const geetestChallenge = firstString(record.geetest_challenge, record.geetestChallenge, record.challenge);
  const geetestValidate = firstString(record.geetest_validate, record.geetestValidate, record.validate);
  const geetestSeccode = firstString(record.geetest_seccode, record.geetestSeccode, record.seccode);

  if (!geetestChallenge || !geetestValidate || !geetestSeccode) {
    return null;
  }

  return {
    geetestChallenge,
    geetestValidate,
    geetestSeccode,
  };
}

export async function verifyGeeTest(
  payload: GeeTestValidationPayload,
  opts: GeeTestValidateOptions = {},
): Promise<GeeTestValidationResult> {
  const { enabled, captchaId, apiServer } = getGeeTestConfig();
  if (!enabled) {
    return { success: true, reason: "geetest disabled" };
  }

  const issued = issuedChallenges.get(payload.geetestChallenge);
  const failback = issued?.success === 0;

  if (failback) {
    if (!payload.geetestChallenge.trim() || !payload.geetestValidate.trim() || !payload.geetestSeccode.trim()) {
      return {
        success: false,
        reason: "failback params missing",
      };
    }

    return {
      success: true,
      reason: "success",
    };
  }

  const body = new URLSearchParams({
    seccode: payload.geetestSeccode,
    challenge: payload.geetestChallenge,
    json_format: "1",
    sdk: SDK_ID,
    captchaid: captchaId,
    client_type: opts.clientType ?? "web",
  });
  if (opts.userId) body.set("user_id", opts.userId);
  if (opts.ipAddress) body.set("ip_address", opts.ipAddress);

  const response = await fetch(`${apiServer}/validate.php`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (!response.ok) {
    throw new Error(`GEETEST_VALIDATE_HTTP_${response.status}`);
  }

  const data = (await response.json()) as GeeTestValidateApiResponse;
  const result = firstString(data.result)?.toLowerCase() ?? null;
  if (result === "success") {
    return {
      success: true,
      reason: "success",
      raw: data,
    };
  }

  const returnedSeccode = firstString(data.seccode);
  if (result === "fail" || !returnedSeccode || isFalseLike(returnedSeccode)) {
    return {
      success: false,
      reason: firstString(data.msg, data.message) ?? "validation failed",
      raw: data,
    };
  }

  return {
    success: true,
    reason: "success",
    raw: data,
  };
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}
