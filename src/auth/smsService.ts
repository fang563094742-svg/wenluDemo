/**
 * 问路 — 短信验证码服务。
 *
 * 开发阶段使用 console.log 打印验证码。
 * 生产环境对接真实短信 API 时只需替换 sendSmsCode 实现。
 */

import { saveSmsCode, verifySmsCode as dbVerifySmsCode } from "../db/smsCodeRepo.js";

const CODE_LENGTH = 6;
const CODE_EXPIRE_SECONDS = 300; // 5 分钟

/** 生成 N 位数字验证码。 */
function generateCode(length: number): string {
  let code = "";
  for (let i = 0; i < length; i++) {
    code += Math.floor(Math.random() * 10).toString();
  }
  return code;
}

/**
 * 发送验证码。
 * 开发阶段直接 console 输出；生产替换为真实短信 API。
 */
export async function sendSmsCode(phone: string): Promise<{ success: boolean; message?: string }> {
  // 频率限制：同一手机号 60 秒内不能重复发送（由数据库 repo 层保证）
  const code = generateCode(CODE_LENGTH);

  try {
    await saveSmsCode(phone, code, CODE_EXPIRE_SECONDS);
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes("频率限制")) {
      return { success: false, message: "发送过于频繁，请 60 秒后再试" };
    }
    throw err;
  }

  // ===== 开发模式：打印验证码 =====
  console.log(`[SMS-DEV] 手机号 ${phone} 的验证码是: ${code}`);
  // ===== 生产模式：替换为真实短信服务 =====
  // await realSmsApi.send(phone, `您的验证码是 ${code}，5分钟内有效`);

  return { success: true };
}

/**
 * 校验验证码。
 */
export async function verifySmsCode(phone: string, code: string): Promise<boolean> {
  return dbVerifySmsCode(phone, code);
}
