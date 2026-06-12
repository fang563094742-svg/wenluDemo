import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const PASSWORD_SCHEME = "scrypt";
const SALT_BYTES = 16;
const KEY_LENGTH = 64;

export function normalizePasswordUsername(username: string): string {
  return username.trim().toLowerCase();
}

export function validateUsername(username: string): string | null {
  const normalized = normalizePasswordUsername(username);
  if (!normalized) {
    return "用户名不能为空";
  }
  if (normalized.length < 4 || normalized.length > 32) {
    return "用户名长度需为 4-32 位";
  }
  if (!/^[a-z0-9](?:[a-z0-9._-]{2,30}[a-z0-9])?$/.test(normalized)) {
    return "用户名仅支持字母、数字、点、下划线、短横线，且不能以下划线或符号开头/结尾";
  }
  return null;
}

export function validatePassword(password: string): string | null {
  if (!password) {
    return "密码不能为空";
  }
  if (password.length < 8 || password.length > 72) {
    return "密码长度需为 8-72 位";
  }
  return null;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES).toString("base64url");
  const derived = (await scrypt(password, salt, KEY_LENGTH)) as Buffer;
  return [PASSWORD_SCHEME, salt, derived.toString("base64url")].join("$");
}

export async function verifyPassword(password: string, passwordHash: string | null | undefined): Promise<boolean> {
  if (!passwordHash) {
    return false;
  }

  const [scheme, salt, expected] = passwordHash.split("$");
  if (scheme !== PASSWORD_SCHEME || !salt || !expected) {
    return false;
  }

  const actual = (await scrypt(password, salt, KEY_LENGTH)) as Buffer;
  const expectedBuffer = Buffer.from(expected, "base64url");

  if (actual.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(actual, expectedBuffer);
}
