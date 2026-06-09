/**
 * 问路 — 微信 OAuth 登录服务。
 *
 * 两种模式:
 *  1. Mock 模式 (WECHAT_MOCK=true 或未配 AppID): 用 code 直接当 openid，跑通全流程
 *  2. 真实模式: 拿到 AppID/Secret 后一键切换
 *
 * 流程 (iOS App 端):
 *  - 客户端拉起微信 SDK 授权，拿到 code
 *  - 客户端 POST /api/auth/wechat { code }
 *  - 服务端用 code 换 access_token + openid + unionid
 *  - 服务端可选拉取用户信息(头像/昵称)
 */

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

const WECHAT_APP_ID = process.env.WECHAT_APP_ID ?? "";
const WECHAT_APP_SECRET = process.env.WECHAT_APP_SECRET ?? "";
const WECHAT_MOCK = process.env.WECHAT_MOCK === "true" || !WECHAT_APP_ID;

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export interface WechatTokenResult {
  openid: string;
  unionid?: string;
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
}

export interface WechatUserInfo {
  openid: string;
  unionid?: string;
  nickname: string;
  avatarUrl: string;
  sex: number; // 1=男 2=女 0=未知
}

// ---------------------------------------------------------------------------
// Mock 实现
// ---------------------------------------------------------------------------

function mockCodeToToken(code: string): WechatTokenResult {
  // Mock: code 就当 openid 用，方便调试
  return {
    openid: `mock_openid_${code}`,
    unionid: `mock_unionid_${code}`,
    accessToken: `mock_access_token_${Date.now()}`,
    expiresIn: 7200,
  };
}

function mockGetUserInfo(_accessToken: string, openid: string): WechatUserInfo {
  return {
    openid,
    unionid: openid.replace("openid", "unionid"),
    nickname: `问路用户_${openid.slice(-4)}`,
    avatarUrl: "",
    sex: 0,
  };
}

// ---------------------------------------------------------------------------
// 真实微信 API 实现
// ---------------------------------------------------------------------------

async function realCodeToToken(code: string): Promise<WechatTokenResult> {
  const url = `https://api.weixin.qq.com/sns/oauth2/access_token?appid=${WECHAT_APP_ID}&secret=${WECHAT_APP_SECRET}&code=${code}&grant_type=authorization_code`;
  const resp = await fetch(url);
  const data = (await resp.json()) as Record<string, unknown>;

  if (data.errcode) {
    throw new Error(`微信授权失败: ${data.errmsg} (${data.errcode})`);
  }

  return {
    openid: data.openid as string,
    unionid: data.unionid as string | undefined,
    accessToken: data.access_token as string,
    refreshToken: data.refresh_token as string | undefined,
    expiresIn: (data.expires_in as number) ?? 7200,
  };
}

async function realGetUserInfo(accessToken: string, openid: string): Promise<WechatUserInfo> {
  const url = `https://api.weixin.qq.com/sns/userinfo?access_token=${accessToken}&openid=${openid}&lang=zh_CN`;
  const resp = await fetch(url);
  const data = (await resp.json()) as Record<string, unknown>;

  if (data.errcode) {
    throw new Error(`获取微信用户信息失败: ${data.errmsg}`);
  }

  return {
    openid: data.openid as string,
    unionid: data.unionid as string | undefined,
    nickname: (data.nickname as string) ?? "",
    avatarUrl: (data.headimgurl as string) ?? "",
    sex: (data.sex as number) ?? 0,
  };
}

// ---------------------------------------------------------------------------
// 统一对外接口
// ---------------------------------------------------------------------------

/** 用 code 换取 token 和 openid。 */
export async function codeToToken(code: string): Promise<WechatTokenResult> {
  if (WECHAT_MOCK) {
    console.log("[wechat] Mock 模式: code →", code);
    return mockCodeToToken(code);
  }
  return realCodeToToken(code);
}

/** 拉取微信用户信息（昵称、头像）。 */
export async function getWechatUserInfo(accessToken: string, openid: string): Promise<WechatUserInfo> {
  if (WECHAT_MOCK) {
    return mockGetUserInfo(accessToken, openid);
  }
  return realGetUserInfo(accessToken, openid);
}

/** 是否处于 Mock 模式。 */
export function isMockMode(): boolean {
  return WECHAT_MOCK;
}
