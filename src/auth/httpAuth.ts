import type { IncomingHttpHeaders } from "node:http";
import type { Response } from "express";
import { verifyToken, type JwtPayload } from "./jwt.js";
import type { AuthTokens } from "./authSessionService.js";

const DEFAULT_ACCESS_COOKIE_NAME = "wenlu_access_token";
const DEFAULT_REFRESH_COOKIE_NAME = "wenlu_refresh_token";

type SameSiteValue = "Lax" | "Strict" | "None";

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value) && value.length > 0) {
    return value[0];
  }
  return undefined;
}

function decodeCookieValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseCookieHeader(headers: IncomingHttpHeaders): Map<string, string> {
  const raw = firstHeaderValue(headers.cookie);
  const cookies = new Map<string, string>();
  if (!raw) {
    return cookies;
  }

  for (const segment of raw.split(";")) {
    const trimmed = segment.trim();
    if (!trimmed) {
      continue;
    }
    const divider = trimmed.indexOf("=");
    if (divider <= 0) {
      continue;
    }
    const key = trimmed.slice(0, divider).trim();
    const value = trimmed.slice(divider + 1).trim();
    cookies.set(key, decodeCookieValue(value));
  }

  return cookies;
}

function resolveSameSite(): SameSiteValue {
  const configured = (process.env.AUTH_COOKIE_SAMESITE ?? "Lax").trim().toLowerCase();
  if (configured === "strict") {
    return "Strict";
  }
  if (configured === "none") {
    return "None";
  }
  return "Lax";
}

function resolveCookieSecure(): boolean {
  const explicit = process.env.AUTH_COOKIE_SECURE?.trim().toLowerCase();
  if (explicit === "true") {
    return true;
  }
  if (explicit === "false") {
    return false;
  }
  return process.env.NODE_ENV === "production";
}

function resolveCookiePath(): string {
  const configured = process.env.AUTH_COOKIE_PATH?.trim();
  return configured || "/";
}

function resolveCookieDomain(): string | undefined {
  const configured = process.env.AUTH_COOKIE_DOMAIN?.trim();
  return configured || undefined;
}

function serializeCookie(
  name: string,
  value: string,
  options: {
    expires?: Date;
    httpOnly?: boolean;
    maxAge?: number;
    path?: string;
    sameSite?: SameSiteValue;
    secure?: boolean;
    domain?: string;
  } = {},
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (typeof options.maxAge === "number") {
    parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
  }
  if (options.expires) {
    parts.push(`Expires=${options.expires.toUTCString()}`);
  }
  if (options.domain) {
    parts.push(`Domain=${options.domain}`);
  }
  parts.push(`Path=${options.path ?? "/"}`);
  if (options.httpOnly) {
    parts.push("HttpOnly");
  }
  if (options.secure) {
    parts.push("Secure");
  }
  parts.push(`SameSite=${options.sameSite ?? "Lax"}`);
  return parts.join("; ");
}

function getCookieOptions() {
  return {
    path: resolveCookiePath(),
    domain: resolveCookieDomain(),
    secure: resolveCookieSecure(),
    sameSite: resolveSameSite(),
  };
}

function toMaxAgeSeconds(expiresAt: string): number {
  const expires = new Date(expiresAt).getTime();
  if (!Number.isFinite(expires)) {
    return 0;
  }
  return Math.max(0, Math.floor((expires - Date.now()) / 1000));
}

export function getAccessTokenCookieName(): string {
  return process.env.AUTH_ACCESS_COOKIE_NAME?.trim() || DEFAULT_ACCESS_COOKIE_NAME;
}

export function getRefreshTokenCookieName(): string {
  return process.env.AUTH_REFRESH_COOKIE_NAME?.trim() || DEFAULT_REFRESH_COOKIE_NAME;
}

export function getCookieValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  return parseCookieHeader(headers).get(name);
}

export function getAccessTokenFromHeaders(headers: IncomingHttpHeaders): string | undefined {
  const authHeader = firstHeaderValue(headers.authorization);
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7).trim();
    if (token) {
      return token;
    }
  }
  return getCookieValue(headers, getAccessTokenCookieName());
}

export function getRefreshTokenFromHeaders(headers: IncomingHttpHeaders): string | undefined {
  return getCookieValue(headers, getRefreshTokenCookieName());
}

export function authenticateHeaders(headers: IncomingHttpHeaders): JwtPayload | null {
  const authHeader = firstHeaderValue(headers.authorization);
  if (authHeader?.startsWith("Bearer ")) {
    const bearerToken = authHeader.slice(7).trim();
    if (bearerToken) {
      const bearerPayload = verifyToken(bearerToken);
      if (bearerPayload) {
        return bearerPayload;
      }
    }
  }

  const cookieToken = getCookieValue(headers, getAccessTokenCookieName());
  if (!cookieToken) {
    return null;
  }
  return verifyToken(cookieToken);
}

export function buildAuthCookieHeaders(tokens: AuthTokens): string[] {
  const cookieOptions = getCookieOptions();
  const accessExpires = new Date(tokens.expiresAt);
  const refreshExpires = new Date(tokens.refreshExpiresAt);

  return [
    serializeCookie(getAccessTokenCookieName(), tokens.accessToken, {
      ...cookieOptions,
      httpOnly: true,
      expires: accessExpires,
      maxAge: toMaxAgeSeconds(tokens.expiresAt),
    }),
    serializeCookie(getRefreshTokenCookieName(), tokens.refreshToken, {
      ...cookieOptions,
      httpOnly: true,
      expires: refreshExpires,
      maxAge: toMaxAgeSeconds(tokens.refreshExpiresAt),
    }),
  ];
}

export function buildClearAuthCookieHeaders(): string[] {
  const cookieOptions = getCookieOptions();
  const expiredAt = new Date(0);

  return [
    serializeCookie(getAccessTokenCookieName(), "", {
      ...cookieOptions,
      httpOnly: true,
      expires: expiredAt,
      maxAge: 0,
    }),
    serializeCookie(getRefreshTokenCookieName(), "", {
      ...cookieOptions,
      httpOnly: true,
      expires: expiredAt,
      maxAge: 0,
    }),
  ];
}

export function applyAuthCookies(res: Response, tokens: AuthTokens): void {
  res.setHeader("Set-Cookie", buildAuthCookieHeaders(tokens));
}

export function clearAuthCookies(res: Response): void {
  res.setHeader("Set-Cookie", buildClearAuthCookieHeaders());
}
