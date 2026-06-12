import { Router, type RequestHandler } from "express";
import {
  approveMembershipOrderReview,
  createInviteRewardPolicy,
  getInviteRewardPolicyById,
  getMembershipOrderAggregate,
  getPlanById,
  getPlanPaymentGoodsKey,
  getUserInvitationSummary,
  getUserInviteRewardSummary,
  listInviteRewardPolicies,
  listInvitedUsers,
  markMembershipOrderForManualReview,
  markMembershipOrderPaid,
  query,
  revokeAuthDeviceSessionById,
  addUserBusinessMessageCredits,
  updateInviteRewardPolicy,
  updatePlan,
  extendSubscription,
  withPlanPaymentGoodsKey,
  type AuthDeviceSession,
  type InviteRewardGrant,
  type InviteRewardPolicy,
  type InviteRewardTriggerType,
  type InvitedUserRow,
  type MembershipGrant,
  type MembershipOrder,
  type OrderPaymentRecord,
  type Plan,
  type Subscription,
  type User,
  type UserInvitationSummary,
  type UserInviteRewardSummary,
} from "../db/index.js";
import type { AdminConfig } from "./config.js";

function createBasicAuthMiddleware(config: AdminConfig): RequestHandler | null {
  const { basicAuthUser, basicAuthPassword } = config;
  if (!basicAuthUser || !basicAuthPassword) {
    return null;
  }

  return (req, res, next) => {
    const authorization = req.headers.authorization;
    if (!authorization?.startsWith("Basic ")) {
      res.setHeader("WWW-Authenticate", 'Basic realm="wenlu-admin"');
      res.status(401).send("需要登录认证");
      return;
    }

    const encoded = authorization.slice("Basic ".length);
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const separatorIndex = decoded.indexOf(":");
    const username = separatorIndex >= 0 ? decoded.slice(0, separatorIndex) : decoded;
    const password = separatorIndex >= 0 ? decoded.slice(separatorIndex + 1) : "";

    if (username !== basicAuthUser || password !== basicAuthPassword) {
      res.setHeader("WWW-Authenticate", 'Basic realm="wenlu-admin"');
      res.status(401).send("账号或密码错误");
      return;
    }

    next();
  };
}

type ListPage<T> = {
  rows: T[];
  total: number;
  limit: number;
  offset: number;
  search: string;
};

type UserRow = User & {
  active_plan_id: string | null;
  active_plan_name: string | null;
  active_subscription_expires_at: Date | null;
  subscription_count: number;
  order_count: number;
  active_session_count: number;
  invited_count: number;
  inviter_phone: string | null;
  inviter_username: string | null;
  inviter_nickname: string | null;
};

type SubscriptionRow = Subscription & {
  phone: string | null;
  username: string | null;
  nickname: string | null;
  plan_name: string | null;
};

type SubscriptionWithPlanRow = Subscription & {
  plan_name: string | null;
  price_cents: number | null;
  duration_days: number | null;
  features: Record<string, unknown> | null;
};

type OrderListRow = MembershipOrder & {
  phone: string | null;
  username: string | null;
  nickname: string | null;
  plan_name: string | null;
  latest_payment_status: string | null;
  latest_payment_review_status: string | null;
  latest_payment_provider_transaction_id: string | null;
  latest_payment_review_note: string | null;
  grant_status: string | null;
};

type PaymentListRow = OrderPaymentRecord & {
  order_no: string;
  order_status: string;
  phone: string | null;
  username: string | null;
  nickname: string | null;
};

type GrantListRow = MembershipGrant & {
  order_no: string;
  phone: string | null;
  username: string | null;
  nickname: string | null;
  subscription_is_active: boolean | null;
  plan_name: string | null;
};

type PlanStatsRow = Plan & {
  subscription_count: number;
  active_subscription_count: number;
  order_count: number;
  fulfilled_order_count: number;
  grant_count: number;
};

type InviteRewardPolicyRow = InviteRewardPolicy & {
  reward_plan_name: string | null;
  grant_count: number;
  rewarded_user_count: number;
  last_granted_at: Date | null;
};

type InviteRewardGrantRow = InviteRewardGrant & {
  phone: string | null;
  username: string | null;
  nickname: string | null;
  policy_name: string | null;
  trigger_type: InviteRewardTriggerType | null;
  reward_plan_name: string | null;
  subscription_expires_at: Date | null;
};

type AuthSessionRow = AuthDeviceSession & {
  phone: string | null;
  username: string | null;
  nickname: string | null;
  active_plan_id: string | null;
  active_plan_name: string | null;
};

type DashboardStats = {
  users: number;
  orders: number;
  payments: number;
  grants: number;
  plans: number;
  activeSubscriptions: number;
  reviewQueue: number;
  pendingOrders: number;
  paymentsPendingReview: number;
  activeSessions: number;
  expiringSubscriptions: number;
};

type UserDetail = {
  user: User;
  invitationSummary: UserInvitationSummary;
  inviteRewardSummary: UserInviteRewardSummary;
  invitedUsers: InvitedUserRow[];
  activeSubscription: SubscriptionWithPlanRow | null;
  subscriptions: SubscriptionWithPlanRow[];
  orders: OrderListRow[];
  grants: GrantListRow[];
  sessions: AuthDeviceSession[];
};

type OrderDetail = {
  order: MembershipOrder;
  user: User | null;
  plan: Plan | null;
  subscription: Subscription | null;
  grant: MembershipGrant | null;
  payments: OrderPaymentRecord[];
};

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function truncate(value: string, max = 80): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function formatDateTime(value: Date | string | null | undefined): string {
  if (!value) return "-";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return escapeHtml(value);
  return date.toLocaleString("zh-CN", { hour12: false });
}

function formatMoney(cents: number | null | undefined, currency = "CNY"): string {
  if (typeof cents !== "number") return "-";
  if (currency === "CNY") {
    return `¥${(cents / 100).toFixed(2)}`;
  }
  return `${(cents / 100).toFixed(2)} ${currency}`;
}

function formatPlanDuration(days: number | null | undefined): string {
  if (typeof days !== "number") return "-";
  if (days <= 0) return "长期/不限时";
  if (days === 1) return "1 天";
  if (days === 7) return "7 天";
  if (days === 30) return "1 个月";
  if (days === 90) return "3 个月";
  if (days === 365) return "1 年";
  return `${days} 天`;
}

function formatInviteRewardTriggerType(triggerType: InviteRewardTriggerType | null | undefined): string {
  if (triggerType === "per_count") return "每邀请满 N 人循环奖励";
  if (triggerType === "threshold_once") return "达到门槛一次性奖励";
  return "-";
}

function formatInviteRewardRule(rule: {
  trigger_type: InviteRewardTriggerType | null;
  invite_count_step: number | null;
  threshold_count: number | null;
  reward_duration_days: number;
  max_reward_times?: number | null;
}): string {
  if (rule.trigger_type === "per_count") {
    const suffix = rule.max_reward_times ? `，最多奖励 ${rule.max_reward_times} 次` : "";
    return `每邀请满 ${rule.invite_count_step ?? "-"} 人，送 ${rule.reward_duration_days} 天${suffix}`;
  }
  return `邀请达到 ${rule.threshold_count ?? "-"} 人，一次性送 ${rule.reward_duration_days} 天`;
}

function formatInviteRewardGrantTrigger(rule: {
  trigger_type: InviteRewardTriggerType | null;
  trigger_invited_count: number;
}): string {
  if (rule.trigger_type === "per_count") {
    return `达成第 ${rule.trigger_invited_count} 位邀请用户`;
  }
  return `达到门槛 ${rule.trigger_invited_count} 人`;
}

function formatFeatureValue(value: unknown): string {
  if (Array.isArray(value)) return value.map((item) => String(item)).join(", ");
  if (value && typeof value === "object") return JSON.stringify(value);
  if (value === null || value === undefined) return "-";
  return String(value);
}

function parsePageSize(input: unknown, fallback: number): number {
  const value = typeof input === "string" ? parseInt(input, 10) : Number(input);
  return Number.isFinite(value) && value > 0 ? Math.min(value, 200) : fallback;
}

function parsePositiveInt(input: unknown): number | null {
  const value = typeof input === "string" ? parseInt(input, 10) : Number(input);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function parseOptionalPositiveInt(input: unknown): number | null {
  if (typeof input === "string" && !input.trim()) {
    return null;
  }
  if (input === null || input === undefined) {
    return null;
  }
  return parsePositiveInt(input);
}

function parseIntegerAtLeast(input: unknown, min: number): number | null {
  const value = typeof input === "string" ? parseInt(input, 10) : Number(input);
  return Number.isFinite(value) && value >= min ? Math.trunc(value) : null;
}

function parseOffset(input: unknown): number {
  const value = typeof input === "string" ? parseInt(input, 10) : Number(input);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function parseCheckbox(input: unknown): boolean {
  return input === "on" || input === "true" || input === "1" || input === true;
}

function parseJsonObject(input: unknown): Record<string, unknown> {
  if (typeof input !== "string" || !input.trim()) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new Error("功能配置必须是合法 JSON");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("功能配置必须是 JSON 对象");
  }

  return parsed as Record<string, unknown>;
}

function buildUrl(basePath: string, current: URLSearchParams, patch: Record<string, string | number | null | undefined>): string {
  const next = new URLSearchParams(current);
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined || value === "") next.delete(key);
    else next.set(key, String(value));
  }
  const queryString = next.toString();
  return queryString ? `${basePath}?${queryString}` : basePath;
}

function renderLayout(title: string, body: string, rootPath: string): string {
  const navGroups = [
    {
      label: "概览",
      items: [
        ["控制台", rootPath],
        ["系统状态", `${rootPath}/system-status`],
        ["待复核订单", `${rootPath}/review-queue`],
      ],
    },
    {
      label: "用户中心",
      items: [
        ["用户列表", `${rootPath}/users`],
        ["用户订阅", `${rootPath}/subscriptions`],
        ["设备会话", `${rootPath}/auth-sessions`],
      ],
    },
    {
      label: "交易与发放",
      items: [
        ["会员订单", `${rootPath}/membership-orders`],
        ["支付流水", `${rootPath}/order-payments`],
        ["权益发放", `${rootPath}/membership-grants`],
      ],
    },
  {
      label: "配置中心",
      items: [
        ["会员套餐", `${rootPath}/plans`],
        ["邀请奖励", `${rootPath}/invite-reward-policies`],
      ],
    },
  ];
  const currentYear = new Date().getFullYear();

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f0f2f5;
        --surface: rgba(255,255,255,0.82);
        --border: rgba(0,0,0,0.06);
        --border-strong: rgba(0,0,0,0.08);
        --text: #1d1d1f;
        --secondary: #48484a;
        --muted: #8e8e93;
        --accent: #0071e3;
        --accent-soft: rgba(0,113,227,0.06);
      }
      * { box-sizing: border-box; }
      body {
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Helvetica Neue", sans-serif;
        margin: 0;
        color: var(--text);
        background: var(--bg);
      }
      a { color: var(--accent); text-decoration: none; }
      a:hover { color: #005bb5; }
      .page-shell { display: grid; grid-template-columns: 256px minmax(0, 1fr); min-height: 100vh; }
      .sidebar {
        background: rgba(255,255,255,0.8);
        border-right: 1px solid #f0f0f0;
        backdrop-filter: saturate(180%) blur(20px);
        padding: 18px 14px;
        position: sticky;
        top: 0;
        height: 100vh;
        overflow: auto;
      }
      .brand { display: flex; flex-direction: column; gap: 4px; padding: 6px 8px 16px; border-bottom: 1px solid #f0f0f0; margin-bottom: 16px; }
      .brand .kicker { font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; color: #64748b; }
      .brand h1 { font-size: 18px; margin: 0; color: var(--text); }
      .brand .muted { font-size: 13px; }
      .nav-group { margin-top: 16px; }
      .nav-group h2 { margin: 0 8px 8px; font-size: 12px; color: #94a3b8; letter-spacing: 0.08em; text-transform: uppercase; }
      .nav-group a {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 10px 12px;
        border-radius: 12px;
        color: var(--secondary);
        font-size: 14px;
        margin-bottom: 4px;
        border: 1px solid transparent;
      }
      .nav-group a:hover { background: var(--accent-soft); color: var(--accent); border-color: rgba(0,113,227,0.12); }
      .nav-group a::after { content: "›"; color: #cbd5e1; font-size: 16px; }
      .nav-group a:hover::after { color: var(--accent); }
      .sidebar .panel-stack { gap: 12px; margin-top: 16px; }
      .sidebar .card { border: 1px solid var(--border); box-shadow: none; background: rgba(255,255,255,0.92); border-radius: 12px; }
      .content { min-width: 0; }
      header.topbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        padding: 16px 24px;
        background: rgba(255,255,255,0.8);
        border-bottom: 1px solid #f0f0f0;
        box-shadow: 0 1px 4px rgb(0 21 41 / 8%);
        backdrop-filter: saturate(180%) blur(20px);
        position: sticky;
        top: 0;
        z-index: 5;
      }
      .header-brand { display: flex; align-items: center; gap: 12px; }
      .brand-mark {
        width: 40px;
        height: 40px;
        border-radius: 12px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        font-size: 14px;
        font-weight: 700;
        letter-spacing: 0.08em;
        color: #fff;
        background: linear-gradient(135deg, #0a84ff 0%, #0066cc 100%);
        box-shadow: 0 8px 22px rgba(0,102,204,0.22);
        flex-shrink: 0;
      }
      .title-block h1 { margin: 0; font-size: 22px; color: var(--text); }
      .title-block .muted { font-size: 13px; margin-top: 4px; }
      .top-actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
      main { padding: 24px; }
      .main-footer {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        flex-wrap: wrap;
        padding: 14px 24px 18px;
        border-top: 1px solid #f0f0f0;
        background: rgba(255,255,255,0.72);
        backdrop-filter: saturate(180%) blur(20px);
      }
      .footer-links { display: flex; gap: 12px; flex-wrap: wrap; }
      .footer-links a { color: var(--secondary); }
      .footer-links a:hover { color: var(--accent); }
      .footer-copy { font-size: 12px; color: var(--muted); }
      nav { display: block; }
      h1, h2, h3 { margin: 0 0 12px; }
      .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; margin-bottom: 20px; }
      .card {
        background: var(--surface);
        border-radius: 12px;
        padding: 16px;
        box-shadow: 0 1px 4px rgb(0 21 41 / 8%);
        border: 1px solid rgba(255,255,255,0.68);
        backdrop-filter: saturate(180%) blur(20px);
      }
      .muted { color: #6b7280; }
      .kicker { color: #6b7280; font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; }
      .stat-number { font-size: 32px; font-weight: 700; line-height: 1.1; }
      .stat-label { margin-top: 6px; color: #6b7280; }
      .flash { padding: 12px 16px; border-radius: 12px; margin-bottom: 16px; }
      .flash.ok { background: rgba(48,209,88,0.1); color: #166534; border: 1px solid rgba(48,209,88,0.12); }
      .flash.error { background: rgba(255,69,58,0.1); color: #991b1b; border: 1px solid rgba(255,69,58,0.12); }
      .table-wrap { overflow: auto; }
      table { width: 100%; border-collapse: separate; border-spacing: 0; background: rgba(255,255,255,0.9); border: 1px solid var(--border); border-radius: 14px; overflow: hidden; }
      th, td { padding: 10px 12px; border-bottom: 1px solid var(--border); text-align: left; vertical-align: top; font-size: 14px; }
      th { background: rgba(248,248,250,0.95); font-weight: 600; position: sticky; top: 0; }
      tr:last-child td { border-bottom: none; }
      code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
      code { word-break: break-all; }
      pre { background: #0f172a; color: #e2e8f0; padding: 14px; border-radius: 10px; overflow: auto; margin: 0; }
      .toolbar { display: flex; gap: 12px; flex-wrap: wrap; align-items: end; margin-bottom: 16px; }
      label { display: flex; flex-direction: column; gap: 6px; font-size: 14px; color: #334155; }
      input, select, textarea, button { font: inherit; padding: 9px 10px; border-radius: 10px; border: 1px solid rgba(71,85,105,0.18); background: rgba(255,255,255,0.96); }
      textarea { min-height: 88px; min-width: 280px; }
      button, .btn {
        cursor: pointer;
        background: linear-gradient(135deg, #0a84ff 0%, #0066cc 100%);
        color: white;
        border: 1px solid #0066cc;
        text-decoration: none;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        padding: 9px 12px;
        border-radius: 10px;
        box-shadow: 0 10px 24px rgba(0,102,204,0.18);
      }
      .btn.secondary, button.secondary { background: rgba(255,255,255,0.92); color: var(--secondary); box-shadow: none; border-color: var(--border-strong); }
      .btn.secondary:hover, button.secondary:hover { background: rgba(255,255,255,0.98); color: var(--text); }
      .btn.disabled { opacity: 0.45; pointer-events: none; }
      .pill { display: inline-block; border-radius: 999px; padding: 3px 8px; font-size: 12px; background: rgba(0,0,0,0.06); color: #111827; white-space: nowrap; }
      .pill.pending { background: rgba(255,159,10,0.14); }
      .pill.success, .pill.paid, .pill.fulfilled, .pill.approved, .pill.active { background: rgba(48,209,88,0.14); color: #166534; }
      .pill.review_required, .pill.pending_review { background: rgba(255,159,10,0.16); color: #92400e; }
      .pill.failed, .pill.cancelled, .pill.rejected, .pill.expired { background: rgba(255,69,58,0.14); color: #991b1b; }
      .pill.revoked { background: rgba(148,163,184,0.18); color: #374151; }
      .split { display: grid; grid-template-columns: 2fr 1fr; gap: 16px; }
      .kv { display: grid; grid-template-columns: 180px 1fr; gap: 8px 12px; }
      .kv div { padding: 6px 0; border-bottom: 1px solid #eef2f7; }
      .feature-list { display: flex; gap: 8px; flex-wrap: wrap; }
      .actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
      .inline-form { display: inline; }
      .panel-stack { display: grid; gap: 16px; }
      .section-title { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
      .section-title .muted { font-size: 13px; }
      .empty { color: #6b7280; padding: 12px 0; }
      ul.compact { margin: 0; padding-left: 18px; }
      @media (max-width: 1100px) {
        .page-shell { grid-template-columns: 1fr; }
        .sidebar { position: static; height: auto; border-right: none; border-bottom: 1px solid #e5e7eb; }
      }
      @media (max-width: 960px) {
        .split, .kv { grid-template-columns: 1fr; }
        header.topbar { align-items: flex-start; flex-direction: column; }
        .top-actions { justify-content: flex-start; }
        .main-footer { align-items: flex-start; }
      }
    </style>
  </head>
  <body>
    <div class="page-shell">
      <aside class="sidebar">
        <div class="brand">
          <div class="kicker">Internal Admin</div>
          <h1>问路后台</h1>
          <div class="muted">私有 Basic Auth 入口 · 分区式管理面板</div>
        </div>
        <nav>
          ${navGroups.map((group) => `
            <section class="nav-group">
              <h2>${escapeHtml(group.label)}</h2>
              ${group.items.map(([label, href]) => `<a href="${href}"><span>${escapeHtml(label)}</span></a>`).join("")}
            </section>
          `).join("")}
        </nav>
        <div class="panel-stack">
          <div class="card">
            <div class="kicker">当前入口</div>
            <div style="margin-top:8px; font-weight:600;">${escapeHtml(rootPath)}</div>
            <div class="muted" style="margin-top:6px;">仅通过 Basic Auth 访问</div>
          </div>
          <div class="card">
            <div class="kicker">快捷入口</div>
            <div class="actions" style="margin-top:10px;">
              <a class="btn" href="${rootPath}">总览</a>
              <a class="btn secondary" href="${rootPath}/review-queue">复核队列</a>
            </div>
          </div>
        </div>
      </aside>
      <div class="content">
        <header class="topbar">
          <div class="header-brand">
            <div class="brand-mark">WL</div>
            <div class="title-block">
              <div class="kicker">问路后台控制台</div>
              <h1>${escapeHtml(title)}</h1>
              <div class="muted">浅色 · 分区 · 卡片化管理界面</div>
            </div>
          </div>
          <div class="top-actions">
            <a class="btn secondary" href="${rootPath}/system-status">系统状态</a>
            <a class="btn secondary" href="${rootPath}/users">用户中心</a>
            <a class="btn secondary" href="${rootPath}/membership-orders">交易中心</a>
          </div>
        </header>
        <main>${body}</main>
        <footer class="main-footer">
          <div class="footer-links">
            <a href="${rootPath}">总览</a>
            <a href="${rootPath}/users">用户中心</a>
            <a href="${rootPath}/membership-orders">交易中心</a>
            <a href="${rootPath}/review-queue">复核队列</a>
          </div>
          <div class="footer-copy">问路后台管理 · © ${currentYear}</div>
        </footer>
      </div>
    </div>
  </body>
</html>`;
}

function renderFlash(searchParams: URLSearchParams): string {
  const ok = searchParams.get("ok");
  const error = searchParams.get("error");
  if (ok) return `<div class="flash ok">${escapeHtml(ok)}</div>`;
  if (error) return `<div class="flash error">${escapeHtml(error)}</div>`;
  return "";
}

function renderPagination(basePath: string, params: URLSearchParams, total: number, limit: number, offset: number): string {
  const prevOffset = Math.max(0, offset - limit);
  const nextOffset = offset + limit;
  const start = total === 0 ? 0 : offset + 1;
  const end = total === 0 ? 0 : Math.min(offset + limit, total);
  const prevLink = offset <= 0
    ? `<span class="btn secondary disabled">上一页</span>`
    : `<a class="btn secondary" href="${buildUrl(basePath, params, { offset: prevOffset })}">上一页</a>`;
  const nextLink = nextOffset >= total
    ? `<span class="btn secondary disabled">下一页</span>`
    : `<a class="btn secondary" href="${buildUrl(basePath, params, { offset: nextOffset })}">下一页</a>`;

  return `<div style="margin-top:16px; display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap;">
    <div class="muted">共 ${total} 条，当前 ${start}-${end}</div>
    <div style="display:flex; gap:8px;">${prevLink}${nextLink}</div>
  </div>`;
}

function translatePillLabel(value: string): string {
  const labels: Record<string, string> = {
    active: "有效",
    approved: "已通过",
    cancelled: "已取消",
    expired: "已过期",
    failed: "失败",
    fulfilled: "已发放",
    paid: "已支付",
    pending: "待处理",
    pending_review: "待审核",
    rejected: "已拒绝",
    review_required: "待复核",
    revoked: "已撤销",
    success: "成功",
    granted: "已发放",
    inactive: "已停用",
  };
  return labels[value] ?? value;
}

function renderPill(value: string | null | undefined): string {
  if (!value) return "-";
  return `<span class="pill ${escapeHtml(value)}">${escapeHtml(translatePillLabel(value))}</span>`;
}

function renderSelectOptions(
  current: string,
  options: Array<{ value: string; label: string }>,
): string {
  return options
    .map(({ value, label }) => `<option value="${escapeHtml(value)}"${current === value ? " selected" : ""}>${escapeHtml(label)}</option>`)
    .join("");
}

function renderFeatures(features: Record<string, unknown> | null | undefined): string {
  if (!features || typeof features !== "object" || Array.isArray(features)) {
    return '<span class="muted">无特性配置</span>';
  }
  const entries = Object.entries(features);
  if (entries.length === 0) {
    return '<span class="muted">无特性配置</span>';
  }
  return `<div class="feature-list">${entries.map(([key, value]) => `<span class="pill">${escapeHtml(key)}: ${escapeHtml(formatFeatureValue(value))}</span>`).join("")}</div>`;
}

function formatPlanPaymentGoodsKey(plan: { features: Record<string, unknown> | null | undefined }): string {
  return getPlanPaymentGoodsKey(plan) ?? "-";
}

function renderJson(value: unknown): string {
  return `<pre>${escapeHtml(JSON.stringify(value ?? null, null, 2))}</pre>`;
}

function renderUserCell(rootPath: string, userId: string, identity: { phone: string | null; username: string | null; nickname: string | null }): string {
  const primary = identity.username ?? identity.phone ?? identity.nickname ?? userId;
  const secondary = [identity.nickname, identity.phone, identity.username]
    .filter((item): item is string => Boolean(item))
    .filter((item, index, arr) => arr.indexOf(item) === index && item !== primary);

  return `
    <a href="${rootPath}/users/${userId}"><strong>${escapeHtml(primary)}</strong></a>
    <div class="muted"><code>${escapeHtml(userId)}</code></div>
    ${secondary.length ? `<div class="muted">${secondary.map((item) => escapeHtml(item)).join(" · ")}</div>` : ""}
  `;
}

function renderPlanCell(planId: string, planName: string | null | undefined): string {
  return `<strong>${escapeHtml(planName ?? planId)}</strong><div class="muted">${escapeHtml(planId)}</div>`;
}

function getAuthSessionState(session: Pick<AuthDeviceSession, "revoked_at" | "refresh_expires_at">): "active" | "expired" | "revoked" {
  if (session.revoked_at) return "revoked";
  const expiresAt = session.refresh_expires_at instanceof Date
    ? session.refresh_expires_at
    : new Date(session.refresh_expires_at);
  if (!Number.isNaN(expiresAt.getTime()) && expiresAt.getTime() <= Date.now()) return "expired";
  return "active";
}

function normalizeReturnTo(config: AdminConfig, raw: unknown, fallback: string): string {
  if (typeof raw === "string" && raw.startsWith(config.rootPath)) {
    return raw;
  }
  return fallback;
}

async function listUsers(limit: number, offset: number, search: string): Promise<ListPage<UserRow>> {
  const pattern = search ? `%${search}%` : null;
  const where = pattern
    ? `WHERE u.id::text ILIKE $3
        OR COALESCE(u.phone, '') ILIKE $3
        OR COALESCE(u.username, '') ILIKE $3
        OR COALESCE(u.nickname, '') ILIKE $3
        OR COALESCE(u.invite_code, '') ILIKE $3
        OR COALESCE(inviter.phone, '') ILIKE $3
        OR COALESCE(inviter.username, '') ILIKE $3
        OR COALESCE(inviter.nickname, '') ILIKE $3`
    : "";
  const params: unknown[] = pattern ? [limit, offset, pattern] : [limit, offset];
  const result = await query<UserRow & { total_count: string }>(
    `SELECT
       u.*,
       active_sub.plan_id AS active_plan_id,
       active_plan.name AS active_plan_name,
       active_sub.expires_at AS active_subscription_expires_at,
       (SELECT COUNT(*) FROM subscriptions s2 WHERE s2.user_id = u.id)::int AS subscription_count,
       (SELECT COUNT(*) FROM membership_orders mo WHERE mo.user_id = u.id)::int AS order_count,
       (SELECT COUNT(*) FROM auth_device_sessions ads WHERE ads.user_id = u.id AND ads.revoked_at IS NULL AND ads.refresh_expires_at > NOW())::int AS active_session_count,
       (SELECT COUNT(*) FROM users child WHERE child.invited_by_user_id = u.id)::int AS invited_count,
       inviter.phone AS inviter_phone,
       inviter.username AS inviter_username,
       inviter.nickname AS inviter_nickname,
       COUNT(*) OVER()::int AS total_count
     FROM users u
     LEFT JOIN LATERAL (
       SELECT plan_id, expires_at
       FROM subscriptions
       WHERE user_id = u.id AND is_active = TRUE
       ORDER BY created_at DESC
       LIMIT 1
     ) active_sub ON TRUE
     LEFT JOIN plans active_plan ON active_plan.id = active_sub.plan_id
     LEFT JOIN users inviter ON inviter.id = u.invited_by_user_id
     ${where}
     ORDER BY u.created_at DESC
     LIMIT $1 OFFSET $2`,
    params,
  );
  return { rows: result.rows, total: Number(result.rows[0]?.total_count ?? 0), limit, offset, search };
}

async function listSubscriptions(limit: number, offset: number, search: string): Promise<ListPage<SubscriptionRow>> {
  const pattern = search ? `%${search}%` : null;
  const where = pattern
    ? `WHERE s.id::text ILIKE $3 OR s.user_id::text ILIKE $3 OR COALESCE(s.plan_id, '') ILIKE $3 OR COALESCE(u.phone, '') ILIKE $3 OR COALESCE(u.username, '') ILIKE $3 OR COALESCE(u.nickname, '') ILIKE $3 OR COALESCE(p.name, '') ILIKE $3`
    : "";
  const params: unknown[] = pattern ? [limit, offset, pattern] : [limit, offset];
  const result = await query<SubscriptionRow & { total_count: string }>(
    `SELECT s.*, u.phone, u.username, u.nickname, p.name AS plan_name, COUNT(*) OVER()::int AS total_count
     FROM subscriptions s
     JOIN users u ON u.id = s.user_id
     LEFT JOIN plans p ON p.id = s.plan_id
     ${where}
     ORDER BY s.created_at DESC
     LIMIT $1 OFFSET $2`,
    params,
  );
  return { rows: result.rows, total: Number(result.rows[0]?.total_count ?? 0), limit, offset, search };
}

async function listMembershipOrders(limit: number, offset: number, search: string, status: string, reviewStatus: string): Promise<ListPage<OrderListRow>> {
  const clauses: string[] = [];
  const params: unknown[] = [limit, offset];
  if (search) {
    params.push(`%${search}%`);
    const index = params.length;
    clauses.push(`(mo.id::text ILIKE $${index} OR mo.order_no ILIKE $${index} OR mo.user_id::text ILIKE $${index} OR COALESCE(mo.client_reference, '') ILIKE $${index} OR COALESCE(u.phone, '') ILIKE $${index} OR COALESCE(u.username, '') ILIKE $${index} OR COALESCE(u.nickname, '') ILIKE $${index})`);
  }
  if (status) {
    params.push(status);
    clauses.push(`mo.status = $${params.length}`);
  }
  if (reviewStatus) {
    params.push(reviewStatus);
    clauses.push(`mo.review_status = $${params.length}`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const result = await query<OrderListRow & { total_count: string }>(
    `SELECT
       mo.*,
       u.phone,
       u.username,
       u.nickname,
       p.name AS plan_name,
       op.status AS latest_payment_status,
       op.review_status AS latest_payment_review_status,
       op.provider_transaction_id AS latest_payment_provider_transaction_id,
       op.review_note AS latest_payment_review_note,
       mg.grant_status,
       COUNT(*) OVER()::int AS total_count
     FROM membership_orders mo
     JOIN users u ON u.id = mo.user_id
     LEFT JOIN plans p ON p.id = mo.plan_id
     LEFT JOIN LATERAL (
       SELECT status, review_status, provider_transaction_id, review_note
       FROM order_payments
       WHERE order_id = mo.id
       ORDER BY created_at DESC
       LIMIT 1
     ) op ON TRUE
     LEFT JOIN membership_grants mg ON mg.order_id = mo.id
     ${where}
     ORDER BY mo.created_at DESC
     LIMIT $1 OFFSET $2`,
    params,
  );
  return { rows: result.rows, total: Number(result.rows[0]?.total_count ?? 0), limit, offset, search };
}

async function listReviewQueue(limit: number, offset: number, search: string): Promise<ListPage<OrderListRow>> {
  const clauses: string[] = [
    `(mo.review_status = 'pending_review' OR mo.status = 'review_required' OR COALESCE(op.review_status, '') = 'pending_review' OR COALESCE(op.status, '') = 'review_required')`,
  ];
  const params: unknown[] = [limit, offset];
  if (search) {
    params.push(`%${search}%`);
    const index = params.length;
    clauses.push(`(mo.id::text ILIKE $${index} OR mo.order_no ILIKE $${index} OR mo.user_id::text ILIKE $${index} OR COALESCE(mo.client_reference, '') ILIKE $${index} OR COALESCE(u.phone, '') ILIKE $${index} OR COALESCE(u.username, '') ILIKE $${index} OR COALESCE(u.nickname, '') ILIKE $${index} OR COALESCE(op.provider_transaction_id, '') ILIKE $${index})`);
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const result = await query<OrderListRow & { total_count: string }>(
    `SELECT
       mo.*,
       u.phone,
       u.username,
       u.nickname,
       p.name AS plan_name,
       op.status AS latest_payment_status,
       op.review_status AS latest_payment_review_status,
       op.provider_transaction_id AS latest_payment_provider_transaction_id,
       op.review_note AS latest_payment_review_note,
       mg.grant_status,
       COUNT(*) OVER()::int AS total_count
     FROM membership_orders mo
     JOIN users u ON u.id = mo.user_id
     LEFT JOIN plans p ON p.id = mo.plan_id
     LEFT JOIN LATERAL (
       SELECT status, review_status, provider_transaction_id, review_note
       FROM order_payments
       WHERE order_id = mo.id
       ORDER BY created_at DESC
       LIMIT 1
     ) op ON TRUE
     LEFT JOIN membership_grants mg ON mg.order_id = mo.id
     ${where}
     ORDER BY
       CASE
         WHEN mo.review_status = 'pending_review' THEN 0
         WHEN mo.status = 'review_required' THEN 1
         WHEN COALESCE(op.review_status, '') = 'pending_review' THEN 2
         ELSE 3
       END,
       COALESCE(mo.reviewed_at, mo.updated_at, mo.created_at) DESC
     LIMIT $1 OFFSET $2`,
    params,
  );
  return { rows: result.rows, total: Number(result.rows[0]?.total_count ?? 0), limit, offset, search };
}

async function listOrderPayments(limit: number, offset: number, search: string, status: string, reviewStatus: string): Promise<ListPage<PaymentListRow>> {
  const clauses: string[] = [];
  const params: unknown[] = [limit, offset];
  if (search) {
    params.push(`%${search}%`);
    const index = params.length;
    clauses.push(`(op.id::text ILIKE $${index} OR op.order_id::text ILIKE $${index} OR COALESCE(op.provider_transaction_id, '') ILIKE $${index} OR COALESCE(op.provider, '') ILIKE $${index} OR COALESCE(op.channel, '') ILIKE $${index} OR mo.order_no ILIKE $${index} OR COALESCE(u.phone, '') ILIKE $${index} OR COALESCE(u.username, '') ILIKE $${index} OR COALESCE(u.nickname, '') ILIKE $${index})`);
  }
  if (status) {
    params.push(status);
    clauses.push(`op.status = $${params.length}`);
  }
  if (reviewStatus) {
    params.push(reviewStatus);
    clauses.push(`op.review_status = $${params.length}`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const result = await query<PaymentListRow & { total_count: string }>(
    `SELECT op.*, mo.order_no, mo.status AS order_status, u.phone, u.username, u.nickname, COUNT(*) OVER()::int AS total_count
     FROM order_payments op
     JOIN membership_orders mo ON mo.id = op.order_id
     JOIN users u ON u.id = op.user_id
     ${where}
     ORDER BY op.created_at DESC
     LIMIT $1 OFFSET $2`,
    params,
  );
  return { rows: result.rows, total: Number(result.rows[0]?.total_count ?? 0), limit, offset, search };
}

async function listMembershipGrants(limit: number, offset: number, search: string): Promise<ListPage<GrantListRow>> {
  const pattern = search ? `%${search}%` : null;
  const where = pattern
    ? `WHERE mg.id::text ILIKE $3 OR mg.order_id::text ILIKE $3 OR mg.subscription_id::text ILIKE $3 OR mo.order_no ILIKE $3 OR COALESCE(u.phone, '') ILIKE $3 OR COALESCE(u.username, '') ILIKE $3 OR COALESCE(p.name, '') ILIKE $3`
    : "";
  const params: unknown[] = pattern ? [limit, offset, pattern] : [limit, offset];
  const result = await query<GrantListRow & { total_count: string }>(
    `SELECT mg.*, mo.order_no, u.phone, u.username, u.nickname, s.is_active AS subscription_is_active, p.name AS plan_name, COUNT(*) OVER()::int AS total_count
     FROM membership_grants mg
     JOIN membership_orders mo ON mo.id = mg.order_id
     JOIN users u ON u.id = mg.user_id
     JOIN subscriptions s ON s.id = mg.subscription_id
     LEFT JOIN plans p ON p.id = mg.plan_id
     ${where}
     ORDER BY mg.created_at DESC
     LIMIT $1 OFFSET $2`,
    params,
  );
  return { rows: result.rows, total: Number(result.rows[0]?.total_count ?? 0), limit, offset, search };
}

async function listInviteRewardPolicyStats(): Promise<InviteRewardPolicyRow[]> {
  const result = await query<InviteRewardPolicyRow>(
    `SELECT
       p.*,
       reward_plan.name AS reward_plan_name,
       COUNT(g.id)::int AS grant_count,
       COUNT(DISTINCT g.user_id)::int AS rewarded_user_count,
       MAX(g.granted_at) AS last_granted_at
     FROM invite_reward_policies p
     LEFT JOIN plans reward_plan ON reward_plan.id = p.reward_plan_id
     LEFT JOIN invite_reward_grants g ON g.policy_id = p.id
     GROUP BY p.id, reward_plan.name
     ORDER BY p.is_active DESC, p.sort_order ASC, p.created_at ASC`,
  );
  return result.rows;
}

async function listInviteRewardGrants(limit: number, offset: number, search: string): Promise<ListPage<InviteRewardGrantRow>> {
  const pattern = search ? `%${search}%` : null;
  const where = pattern
    ? `WHERE g.id::text ILIKE $3
        OR g.user_id::text ILIKE $3
        OR COALESCE(u.phone, '') ILIKE $3
        OR COALESCE(u.username, '') ILIKE $3
        OR COALESCE(u.nickname, '') ILIKE $3
        OR COALESCE(p.name, '') ILIKE $3
        OR COALESCE(reward_plan.name, '') ILIKE $3
        OR COALESCE(g.note, '') ILIKE $3`
    : "";
  const params: unknown[] = pattern ? [limit, offset, pattern] : [limit, offset];
  const result = await query<InviteRewardGrantRow & { total_count: string }>(
    `SELECT
       g.*,
       u.phone,
       u.username,
       u.nickname,
       p.name AS policy_name,
       p.trigger_type,
       reward_plan.name AS reward_plan_name,
       s.expires_at AS subscription_expires_at,
       COUNT(*) OVER()::int AS total_count
     FROM invite_reward_grants g
     JOIN users u ON u.id = g.user_id
     JOIN invite_reward_policies p ON p.id = g.policy_id
     LEFT JOIN plans reward_plan ON reward_plan.id = g.reward_plan_id
     JOIN subscriptions s ON s.id = g.subscription_id
     ${where}
     ORDER BY g.granted_at DESC, g.created_at DESC
     LIMIT $1 OFFSET $2`,
    params,
  );
  return { rows: result.rows, total: Number(result.rows[0]?.total_count ?? 0), limit, offset, search };
}

async function listPlanStats(): Promise<PlanStatsRow[]> {
  const result = await query<PlanStatsRow>(
    `SELECT
       p.*,
       COUNT(DISTINCT s.id)::int AS subscription_count,
       COUNT(DISTINCT CASE WHEN s.is_active = TRUE AND (s.expires_at IS NULL OR s.expires_at > NOW()) THEN s.id END)::int AS active_subscription_count,
       COUNT(DISTINCT mo.id)::int AS order_count,
       COUNT(DISTINCT CASE WHEN mo.status = 'fulfilled' THEN mo.id END)::int AS fulfilled_order_count,
       COUNT(DISTINCT mg.id)::int AS grant_count
     FROM plans p
     LEFT JOIN subscriptions s ON s.plan_id = p.id
     LEFT JOIN membership_orders mo ON mo.plan_id = p.id
     LEFT JOIN membership_grants mg ON mg.plan_id = p.id
     GROUP BY p.id, p.name, p.price_cents, p.duration_days, p.features, p.created_at
     ORDER BY p.price_cents ASC, p.created_at ASC`,
  );
  return result.rows;
}

async function listAuthSessions(limit: number, offset: number, search: string, status: string): Promise<ListPage<AuthSessionRow>> {
  const clauses: string[] = [];
  const params: unknown[] = [limit, offset];
  if (search) {
    params.push(`%${search}%`);
    const index = params.length;
    clauses.push(`(ads.id::text ILIKE $${index} OR ads.user_id::text ILIKE $${index} OR COALESCE(u.phone, '') ILIKE $${index} OR COALESCE(u.username, '') ILIKE $${index} OR COALESCE(u.nickname, '') ILIKE $${index} OR COALESCE(ads.device_name, '') ILIKE $${index} OR COALESCE(ads.platform, '') ILIKE $${index} OR COALESCE(ads.last_ip, '') ILIKE $${index})`);
  }
  if (status === "active") {
    clauses.push(`ads.revoked_at IS NULL AND ads.refresh_expires_at > NOW()`);
  } else if (status === "expired") {
    clauses.push(`ads.revoked_at IS NULL AND ads.refresh_expires_at <= NOW()`);
  } else if (status === "revoked") {
    clauses.push(`ads.revoked_at IS NOT NULL`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const result = await query<AuthSessionRow & { total_count: string }>(
    `SELECT
       ads.*,
       u.phone,
       u.username,
       u.nickname,
       active_sub.plan_id AS active_plan_id,
       active_plan.name AS active_plan_name,
       COUNT(*) OVER()::int AS total_count
     FROM auth_device_sessions ads
     JOIN users u ON u.id = ads.user_id
     LEFT JOIN LATERAL (
       SELECT s.plan_id
       FROM subscriptions s
       WHERE s.user_id = ads.user_id AND s.is_active = TRUE AND (s.expires_at IS NULL OR s.expires_at > NOW())
       ORDER BY s.created_at DESC
       LIMIT 1
     ) active_sub ON TRUE
     LEFT JOIN plans active_plan ON active_plan.id = active_sub.plan_id
     ${where}
     ORDER BY ads.last_seen_at DESC, ads.created_at DESC
     LIMIT $1 OFFSET $2`,
    params,
  );
  return { rows: result.rows, total: Number(result.rows[0]?.total_count ?? 0), limit, offset, search };
}

async function fetchStats(): Promise<DashboardStats> {
  const [users, orders, payments, grants, plans, activeSubscriptions, reviewQueue, pendingOrders, paymentsPendingReview, activeSessions, expiringSubscriptions] = await Promise.all([
    query<{ count: string }>("SELECT COUNT(*)::text AS count FROM users"),
    query<{ count: string }>("SELECT COUNT(*)::text AS count FROM membership_orders"),
    query<{ count: string }>("SELECT COUNT(*)::text AS count FROM order_payments"),
    query<{ count: string }>("SELECT COUNT(*)::text AS count FROM membership_grants"),
    query<{ count: string }>("SELECT COUNT(*)::text AS count FROM plans"),
    query<{ count: string }>("SELECT COUNT(*)::text AS count FROM subscriptions WHERE is_active = TRUE AND (expires_at IS NULL OR expires_at > NOW())"),
    query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM membership_orders mo
       LEFT JOIN LATERAL (
         SELECT status, review_status
         FROM order_payments
         WHERE order_id = mo.id
         ORDER BY created_at DESC
         LIMIT 1
       ) op ON TRUE
       WHERE mo.review_status = 'pending_review'
          OR mo.status = 'review_required'
          OR COALESCE(op.review_status, '') = 'pending_review'
          OR COALESCE(op.status, '') = 'review_required'`,
    ),
    query<{ count: string }>("SELECT COUNT(*)::text AS count FROM membership_orders WHERE status = 'pending'"),
    query<{ count: string }>("SELECT COUNT(*)::text AS count FROM order_payments WHERE status = 'review_required' OR review_status = 'pending_review'"),
    query<{ count: string }>("SELECT COUNT(*)::text AS count FROM auth_device_sessions WHERE revoked_at IS NULL AND refresh_expires_at > NOW()"),
    query<{ count: string }>("SELECT COUNT(*)::text AS count FROM subscriptions WHERE is_active = TRUE AND expires_at IS NOT NULL AND expires_at > NOW() AND expires_at <= NOW() + INTERVAL '7 days'"),
  ]);

  return {
    users: Number(users.rows[0]?.count ?? 0),
    orders: Number(orders.rows[0]?.count ?? 0),
    payments: Number(payments.rows[0]?.count ?? 0),
    grants: Number(grants.rows[0]?.count ?? 0),
    plans: Number(plans.rows[0]?.count ?? 0),
    activeSubscriptions: Number(activeSubscriptions.rows[0]?.count ?? 0),
    reviewQueue: Number(reviewQueue.rows[0]?.count ?? 0),
    pendingOrders: Number(pendingOrders.rows[0]?.count ?? 0),
    paymentsPendingReview: Number(paymentsPendingReview.rows[0]?.count ?? 0),
    activeSessions: Number(activeSessions.rows[0]?.count ?? 0),
    expiringSubscriptions: Number(expiringSubscriptions.rows[0]?.count ?? 0),
  };
}

async function fetchRecentOrders(limit = 8): Promise<OrderListRow[]> {
  const result = await query<OrderListRow>(
    `SELECT
       mo.*,
       u.phone,
       u.username,
       u.nickname,
       p.name AS plan_name,
       op.status AS latest_payment_status,
       op.review_status AS latest_payment_review_status,
       op.provider_transaction_id AS latest_payment_provider_transaction_id,
       op.review_note AS latest_payment_review_note,
       mg.grant_status
     FROM membership_orders mo
     JOIN users u ON u.id = mo.user_id
     LEFT JOIN plans p ON p.id = mo.plan_id
     LEFT JOIN LATERAL (
       SELECT status, review_status, provider_transaction_id, review_note
       FROM order_payments
       WHERE order_id = mo.id
       ORDER BY created_at DESC
       LIMIT 1
     ) op ON TRUE
     LEFT JOIN membership_grants mg ON mg.order_id = mo.id
     ORDER BY mo.created_at DESC
     LIMIT $1`,
    [limit],
  );
  return result.rows;
}

async function fetchRecentPayments(limit = 8): Promise<PaymentListRow[]> {
  const result = await query<PaymentListRow>(
    `SELECT op.*, mo.order_no, mo.status AS order_status, u.phone, u.username, u.nickname
     FROM order_payments op
     JOIN membership_orders mo ON mo.id = op.order_id
     JOIN users u ON u.id = op.user_id
     ORDER BY op.created_at DESC
     LIMIT $1`,
    [limit],
  );
  return result.rows;
}

async function fetchRecentAuthSessions(limit = 8): Promise<AuthSessionRow[]> {
  const result = await query<AuthSessionRow>(
    `SELECT
       ads.*,
       u.phone,
       u.username,
       u.nickname,
       active_sub.plan_id AS active_plan_id,
       active_plan.name AS active_plan_name
     FROM auth_device_sessions ads
     JOIN users u ON u.id = ads.user_id
     LEFT JOIN LATERAL (
       SELECT s.plan_id
       FROM subscriptions s
       WHERE s.user_id = ads.user_id AND s.is_active = TRUE AND (s.expires_at IS NULL OR s.expires_at > NOW())
       ORDER BY s.created_at DESC
       LIMIT 1
     ) active_sub ON TRUE
     LEFT JOIN plans active_plan ON active_plan.id = active_sub.plan_id
     ORDER BY ads.last_seen_at DESC, ads.created_at DESC
     LIMIT $1`,
    [limit],
  );
  return result.rows;
}

async function fetchExpiringSubscriptions(limit = 8): Promise<SubscriptionRow[]> {
  const result = await query<SubscriptionRow>(
    `SELECT s.*, u.phone, u.username, u.nickname, p.name AS plan_name
     FROM subscriptions s
     JOIN users u ON u.id = s.user_id
     LEFT JOIN plans p ON p.id = s.plan_id
     WHERE s.is_active = TRUE
       AND s.expires_at IS NOT NULL
       AND s.expires_at > NOW()
       AND s.expires_at <= NOW() + INTERVAL '7 days'
     ORDER BY s.expires_at ASC
     LIMIT $1`,
    [limit],
  );
  return result.rows;
}

async function ensureReviewPaymentRecord(orderId: string, reviewer: string, reason: string, note?: string): Promise<string | null> {
  const existing = await query<{ id: string }>(
    "SELECT id FROM order_payments WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1",
    [orderId],
  );
  if (existing.rows[0]?.id) return existing.rows[0].id;

  const inserted = await query<{ id: string }>(
    `INSERT INTO order_payments (
       order_id, user_id, channel, provider, amount_cents, currency, status, callback_payload,
       review_status, review_note, reviewed_by, reviewed_at, confirmed_at
     )
     SELECT id, user_id, COALESCE(payment_channel, 'manual'), 'admin', amount_cents, currency,
            'review_required', '{}'::jsonb, 'pending_review', $2, $3, NOW(), NOW()
     FROM membership_orders
     WHERE id = $1
     RETURNING id`,
    [orderId, note ?? reason, reviewer],
  );
  return inserted.rows[0]?.id ?? null;
}

async function fetchOrderDetail(orderId: string): Promise<OrderDetail> {
  const aggregate = await getMembershipOrderAggregate(orderId);
  if (!aggregate) throw new Error("订单不存在");
  const [userResult, paymentsResult, planResult] = await Promise.all([
    query<User>("SELECT * FROM users WHERE id = $1", [aggregate.order.user_id]),
    query<OrderPaymentRecord>("SELECT * FROM order_payments WHERE order_id = $1 ORDER BY created_at DESC", [orderId]),
    query<Plan>("SELECT * FROM plans WHERE id = $1", [aggregate.order.plan_id]),
  ]);

  return {
    order: aggregate.order,
    user: userResult.rows[0] ?? null,
    plan: planResult.rows[0] ?? null,
    subscription: aggregate.subscription,
    grant: aggregate.grant,
    payments: paymentsResult.rows,
  };
}

async function fetchUserDetail(userId: string): Promise<UserDetail> {
  const userResult = await query<User>("SELECT * FROM users WHERE id = $1", [userId]);
  const user = userResult.rows[0];
  if (!user) throw new Error("用户不存在");

  const [
    invitationSummary,
    inviteRewardSummary,
    invitedUsers,
    activeSubscriptionResult,
    subscriptionsResult,
    ordersResult,
    grantsResult,
    sessionsResult,
  ] = await Promise.all([
    getUserInvitationSummary(userId),
    getUserInviteRewardSummary(userId),
    listInvitedUsers(userId, 20),
    query<SubscriptionWithPlanRow>(
      `SELECT s.*, p.name AS plan_name, p.price_cents, p.duration_days, p.features
       FROM subscriptions s
       LEFT JOIN plans p ON p.id = s.plan_id
       WHERE s.user_id = $1 AND s.is_active = TRUE AND (s.expires_at IS NULL OR s.expires_at > NOW())
       ORDER BY s.created_at DESC
       LIMIT 1`,
      [userId],
    ),
    query<SubscriptionWithPlanRow>(
      `SELECT s.*, p.name AS plan_name, p.price_cents, p.duration_days, p.features
       FROM subscriptions s
       LEFT JOIN plans p ON p.id = s.plan_id
       WHERE s.user_id = $1
       ORDER BY s.created_at DESC
       LIMIT 12`,
      [userId],
    ),
    query<OrderListRow>(
      `SELECT
         mo.*,
         u.phone,
         u.username,
         u.nickname,
         p.name AS plan_name,
         op.status AS latest_payment_status,
         op.review_status AS latest_payment_review_status,
         op.provider_transaction_id AS latest_payment_provider_transaction_id,
         op.review_note AS latest_payment_review_note,
         mg.grant_status
       FROM membership_orders mo
       JOIN users u ON u.id = mo.user_id
       LEFT JOIN plans p ON p.id = mo.plan_id
       LEFT JOIN LATERAL (
         SELECT status, review_status, provider_transaction_id, review_note
         FROM order_payments
         WHERE order_id = mo.id
         ORDER BY created_at DESC
         LIMIT 1
       ) op ON TRUE
       LEFT JOIN membership_grants mg ON mg.order_id = mo.id
       WHERE mo.user_id = $1
       ORDER BY mo.created_at DESC
       LIMIT 12`,
      [userId],
    ),
    query<GrantListRow>(
      `SELECT mg.*, mo.order_no, u.phone, u.username, u.nickname, s.is_active AS subscription_is_active, p.name AS plan_name
       FROM membership_grants mg
       JOIN membership_orders mo ON mo.id = mg.order_id
       JOIN users u ON u.id = mg.user_id
       JOIN subscriptions s ON s.id = mg.subscription_id
       LEFT JOIN plans p ON p.id = mg.plan_id
       WHERE mg.user_id = $1
       ORDER BY mg.created_at DESC
       LIMIT 12`,
      [userId],
    ),
    query<AuthDeviceSession>(
      `SELECT *
       FROM auth_device_sessions
      WHERE user_id = $1
      ORDER BY last_seen_at DESC, created_at DESC
      LIMIT 20`,
      [userId],
    ),
  ]);

  return {
    user,
    invitationSummary,
    inviteRewardSummary,
    invitedUsers,
    activeSubscription: activeSubscriptionResult.rows[0] ?? null,
    subscriptions: subscriptionsResult.rows,
    orders: ordersResult.rows,
    grants: grantsResult.rows,
    sessions: sessionsResult.rows,
  };
}

function redirectWithMessage(res: Parameters<RequestHandler>[1], targetPath: string, kind: "ok" | "error", message: string) {
  const params = new URLSearchParams();
  params.set(kind, message);
  res.redirect(`${targetPath}?${params.toString()}`);
}

export async function buildAdminJsRouter(config: AdminConfig): Promise<Router> {
  const router = Router();
  router.use((await import("express")).urlencoded({ extended: false }));

  const basicAuth = createBasicAuthMiddleware(config);
  if (basicAuth) {
    router.use(basicAuth);
  }

  router.get("/", async (req, res) => {
    const [stats, recentOrders, recentPayments, expiringSubscriptions] = await Promise.all([
      fetchStats(),
      fetchRecentOrders(6),
      fetchRecentPayments(6),
      fetchExpiringSubscriptions(6),
    ]);
    const flash = renderFlash(new URLSearchParams(String(req.url.split("?")[1] ?? "")));
    const recentOrdersRows = recentOrders.map((row) => `
      <tr>
        <td><a href="${config.rootPath}/membership-orders/${row.id}"><code>${escapeHtml(row.order_no)}</code></a></td>
        <td>${renderUserCell(config.rootPath, row.user_id, row)}</td>
        <td>${renderPlanCell(row.plan_id, row.plan_name)}</td>
        <td>${formatMoney(row.amount_cents, row.currency)}</td>
        <td>${renderPill(row.status)}</td>
        <td>${renderPill(row.review_status)}</td>
      </tr>`).join("");
    const recentPaymentsRows = recentPayments.map((row) => `
      <tr>
        <td><a href="${config.rootPath}/membership-orders/${row.order_id}">${escapeHtml(row.order_no)}</a></td>
        <td>${renderUserCell(config.rootPath, row.user_id, row)}</td>
        <td>${escapeHtml(row.channel)} / ${escapeHtml(row.provider)}</td>
        <td>${formatMoney(row.amount_cents, row.currency)}</td>
        <td>${renderPill(row.status)}</td>
      </tr>`).join("");
    const expiringRows = expiringSubscriptions.map((row) => `
      <tr>
        <td>${renderUserCell(config.rootPath, row.user_id, row)}</td>
        <td>${renderPlanCell(row.plan_id, row.plan_name)}</td>
        <td>${formatDateTime(row.expires_at)}</td>
        <td>${renderPill(row.is_active ? "active" : "expired")}</td>
      </tr>`).join("");

    res.type("html").send(renderLayout(
      "问路后台总览",
      `${flash}
      <div class="grid">
        <div class="card"><div class="kicker">用户</div><div class="stat-number">${stats.users}</div><div class="stat-label">注册用户总数</div></div>
        <div class="card"><div class="kicker">会员</div><div class="stat-number">${stats.activeSubscriptions}</div><div class="stat-label">当前有效会员</div></div>
        <div class="card"><div class="kicker">复核队列</div><div class="stat-number">${stats.reviewQueue}</div><div class="stat-label">待复核订单/支付</div></div>
        <div class="card"><div class="kicker">设备会话</div><div class="stat-number">${stats.activeSessions}</div><div class="stat-label">活跃设备会话</div></div>
        <div class="card"><div class="kicker">订单</div><div class="stat-number">${stats.orders}</div><div class="stat-label">会员订单总数</div></div>
        <div class="card"><div class="kicker">支付</div><div class="stat-number">${stats.payments}</div><div class="stat-label">支付流水总数</div></div>
        <div class="card"><div class="kicker">7天内到期</div><div class="stat-number">${stats.expiringSubscriptions}</div><div class="stat-label">7 天内到期会员</div></div>
        <div class="card"><div class="kicker">套餐</div><div class="stat-number">${stats.plans}</div><div class="stat-label">当前套餐数</div></div>
      </div>

      <div class="grid">
        <div class="card">
          <h2>运营快捷入口</h2>
          <div class="muted">后台日常处理优先看这里。</div>
          <div class="actions">
            <a class="btn" href="${config.rootPath}/review-queue">处理待复核</a>
            <a class="btn secondary" href="${config.rootPath}/membership-orders?status=pending">查看待支付订单</a>
            <a class="btn secondary" href="${config.rootPath}/auth-sessions?status=active">查看活跃设备</a>
            <a class="btn secondary" href="${config.rootPath}/system-status">系统状态</a>
          </div>
        </div>
        <div class="card">
          <h2>当前风险面</h2>
          <ul class="compact">
            <li>待复核队列：<strong>${stats.reviewQueue}</strong></li>
            <li>待支付订单：<strong>${stats.pendingOrders}</strong></li>
            <li>待复核支付流水：<strong>${stats.paymentsPendingReview}</strong></li>
            <li>7 天内到期会员：<strong>${stats.expiringSubscriptions}</strong></li>
            <li>已发放权益记录：<strong>${stats.grants}</strong></li>
          </ul>
        </div>
        <div class="card">
          <h2>访问说明</h2>
          <div class="muted">管理员后台单独启动，默认只监听本机。</div>
          <ul class="compact">
            <li>地址：<code>http://${escapeHtml(config.host)}:${config.port}${escapeHtml(config.rootPath)}</code></li>
            <li>认证：HTTP Basic Auth</li>
            <li>账号：<code>${escapeHtml(config.basicAuthUser ?? "未配置")}</code></li>
            <li>启动：<code>npm run admin</code></li>
          </ul>
        </div>
      </div>

      <div class="grid">
        <div class="card">
          <div class="section-title"><h2>最新订单</h2><a href="${config.rootPath}/membership-orders">查看全部</a></div>
          <div class="table-wrap"><table><thead><tr><th>订单号</th><th>用户</th><th>套餐</th><th>金额</th><th>状态</th><th>审核</th></tr></thead><tbody>${recentOrdersRows || '<tr><td colspan="6" class="empty">暂无订单</td></tr>'}</tbody></table></div>
        </div>
        <div class="card">
          <div class="section-title"><h2>最新支付</h2><a href="${config.rootPath}/order-payments">查看全部</a></div>
          <div class="table-wrap"><table><thead><tr><th>订单号</th><th>用户</th><th>渠道</th><th>金额</th><th>状态</th></tr></thead><tbody>${recentPaymentsRows || '<tr><td colspan="5" class="empty">暂无支付流水</td></tr>'}</tbody></table></div>
        </div>
      </div>

      <div class="card">
        <div class="section-title"><h2>即将到期会员</h2><a href="${config.rootPath}/subscriptions">查看订阅列表</a></div>
        <div class="table-wrap"><table><thead><tr><th>用户</th><th>套餐</th><th>到期时间</th><th>状态</th></tr></thead><tbody>${expiringRows || '<tr><td colspan="4" class="empty">暂无近期到期会员</td></tr>'}</tbody></table></div>
      </div>`,
      config.rootPath,
    ));
  });

  router.get("/system-status", async (_req, res) => {
    const [stats, recentOrders, recentPayments, expiringSubscriptions, recentSessions] = await Promise.all([
      fetchStats(),
      fetchRecentOrders(10),
      fetchRecentPayments(10),
      fetchExpiringSubscriptions(10),
      fetchRecentAuthSessions(10),
    ]);

    const ordersRows = recentOrders.map((row) => `
      <tr>
        <td><a href="${config.rootPath}/membership-orders/${row.id}"><code>${escapeHtml(row.order_no)}</code></a></td>
        <td>${renderUserCell(config.rootPath, row.user_id, row)}</td>
        <td>${renderPill(row.status)}</td>
        <td>${renderPill(row.review_status)}</td>
        <td>${formatDateTime(row.created_at)}</td>
      </tr>`).join("");
    const paymentsRows = recentPayments.map((row) => `
      <tr>
        <td><a href="${config.rootPath}/membership-orders/${row.order_id}">${escapeHtml(row.order_no)}</a></td>
        <td>${renderUserCell(config.rootPath, row.user_id, row)}</td>
        <td>${renderPill(row.status)}</td>
        <td>${renderPill(row.review_status)}</td>
        <td>${formatDateTime(row.created_at)}</td>
      </tr>`).join("");
    const expiringRows = expiringSubscriptions.map((row) => `
      <tr>
        <td>${renderUserCell(config.rootPath, row.user_id, row)}</td>
        <td>${renderPlanCell(row.plan_id, row.plan_name)}</td>
        <td>${formatDateTime(row.expires_at)}</td>
        <td>${formatDateTime(row.created_at)}</td>
      </tr>`).join("");
    const sessionRows = recentSessions.map((row) => `
      <tr>
        <td>${renderUserCell(config.rootPath, row.user_id, row)}</td>
        <td>${escapeHtml(row.device_name ?? row.platform ?? "-")}${row.user_agent ? `<div class="muted">${escapeHtml(truncate(row.user_agent, 72))}</div>` : ""}</td>
        <td>${renderPlanCell(row.active_plan_id ?? "-", row.active_plan_name)}</td>
        <td>${escapeHtml(row.last_ip ?? "-")}</td>
        <td>${renderPill(getAuthSessionState(row))}</td>
        <td>${formatDateTime(row.last_seen_at)}</td>
      </tr>`).join("");

    res.type("html").send(renderLayout("系统状态", `
      <div class="grid">
        <div class="card"><div class="kicker">用户</div><div class="stat-number">${stats.users}</div><div class="stat-label">全部用户</div></div>
        <div class="card"><div class="kicker">订单</div><div class="stat-number">${stats.orders}</div><div class="stat-label">全部订单</div></div>
        <div class="card"><div class="kicker">支付</div><div class="stat-number">${stats.payments}</div><div class="stat-label">全部支付流水</div></div>
        <div class="card"><div class="kicker">权益发放</div><div class="stat-number">${stats.grants}</div><div class="stat-label">权益发放总数</div></div>
        <div class="card"><div class="kicker">待处理订单</div><div class="stat-number">${stats.pendingOrders}</div><div class="stat-label">等待支付/处理</div></div>
        <div class="card"><div class="kicker">待复核支付</div><div class="stat-number">${stats.paymentsPendingReview}</div><div class="stat-label">待复核支付</div></div>
      </div>

      <div class="grid">
        <div class="card">
          <div class="section-title"><h2>最新订单动态</h2><span class="muted">按创建时间排序</span></div>
          <div class="table-wrap"><table><thead><tr><th>订单号</th><th>用户</th><th>状态</th><th>审核</th><th>创建时间</th></tr></thead><tbody>${ordersRows || '<tr><td colspan="5" class="empty">暂无数据</td></tr>'}</tbody></table></div>
        </div>
        <div class="card">
          <div class="section-title"><h2>最新支付动态</h2><span class="muted">用于核账/复核</span></div>
          <div class="table-wrap"><table><thead><tr><th>订单号</th><th>用户</th><th>状态</th><th>审核</th><th>创建时间</th></tr></thead><tbody>${paymentsRows || '<tr><td colspan="5" class="empty">暂无数据</td></tr>'}</tbody></table></div>
        </div>
      </div>

      <div class="grid">
        <div class="card">
          <div class="section-title"><h2>7 天内到期会员</h2><span class="muted">建议提前触达续费</span></div>
          <div class="table-wrap"><table><thead><tr><th>用户</th><th>套餐</th><th>到期时间</th><th>创建时间</th></tr></thead><tbody>${expiringRows || '<tr><td colspan="4" class="empty">暂无即将到期会员</td></tr>'}</tbody></table></div>
        </div>
        <div class="card">
          <div class="section-title"><h2>最新设备会话</h2><span class="muted">观察设备活跃情况</span></div>
          <div class="table-wrap"><table><thead><tr><th>用户</th><th>设备</th><th>套餐</th><th>IP</th><th>状态</th><th>最后活跃</th></tr></thead><tbody>${sessionRows || '<tr><td colspan="6" class="empty">暂无会话记录</td></tr>'}</tbody></table></div>
        </div>
      </div>

      <div class="card">
        <h2>运维入口</h2>
        <div class="actions">
          <a class="btn" href="${config.rootPath}/review-queue">去处理待复核</a>
          <a class="btn secondary" href="${config.rootPath}/plans">查看套餐配置</a>
          <a class="btn secondary" href="${config.rootPath}/auth-sessions">查看全部设备会话</a>
          <a class="btn secondary" href="/health">应用健康检查</a>
        </div>
      </div>
    `, config.rootPath));
  });

  router.get("/review-queue", async (req, res) => {
    const params = new URLSearchParams(req.query as Record<string, string>);
    const limit = parsePageSize(req.query.limit, 20);
    const offset = parseOffset(req.query.offset);
    const search = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const page = await listReviewQueue(limit, offset, search);
    const rows = page.rows.map((row) => `
      <tr>
        <td><a href="${config.rootPath}/membership-orders/${row.id}"><code>${escapeHtml(row.order_no)}</code></a></td>
        <td>${renderUserCell(config.rootPath, row.user_id, row)}</td>
        <td>${renderPlanCell(row.plan_id, row.plan_name)}</td>
        <td>${formatMoney(row.amount_cents, row.currency)}</td>
        <td>${renderPill(row.status)}</td>
        <td>${renderPill(row.review_status)}</td>
        <td>${renderPill(row.latest_payment_status)}</td>
        <td>${renderPill(row.latest_payment_review_status)}</td>
        <td>${escapeHtml(row.latest_payment_provider_transaction_id ?? row.client_reference ?? "-")}</td>
        <td>${escapeHtml(row.review_reason ?? row.latest_payment_review_note ?? "-")}</td>
        <td>${formatDateTime(row.updated_at)}</td>
      </tr>`).join("");
    res.type("html").send(renderLayout("待复核订单", `
      <h2>待复核队列</h2>
      ${renderFlash(params)}
      <form class="toolbar" method="get">
        <label>搜索<input name="q" value="${escapeHtml(search)}" placeholder="订单号 / 用户 / 联系方式 / 流水号" /></label>
        <label>每页<input name="limit" value="${limit}" /></label>
        <button type="submit">筛选</button>
      </form>
      <div class="table-wrap"><table><thead><tr><th>订单号</th><th>用户</th><th>套餐</th><th>金额</th><th>订单状态</th><th>审核状态</th><th>支付状态</th><th>支付审核</th><th>关联流水</th><th>原因</th><th>更新时间</th></tr></thead><tbody>${rows || '<tr><td colspan="11" class="empty">当前没有待复核记录</td></tr>'}</tbody></table></div>
      ${renderPagination(`${config.rootPath}/review-queue`, params, page.total, limit, offset)}
    `, config.rootPath));
  });

  router.get("/users", async (req, res) => {
    const params = new URLSearchParams(req.query as Record<string, string>);
    const limit = parsePageSize(req.query.limit, 20);
    const offset = parseOffset(req.query.offset);
    const search = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const page = await listUsers(limit, offset, search);
    const rows = page.rows.map((row) => `
      <tr>
        <td>${renderUserCell(config.rootPath, row.id, row)}</td>
        <td>${escapeHtml(row.phone ?? "-")}</td>
        <td>${escapeHtml(row.username ?? "-")}</td>
        <td>${escapeHtml(row.nickname ?? "-")}</td>
        <td><code>${escapeHtml(row.invite_code ?? "-")}</code></td>
        <td>
          <div>邀请人数：<strong>${row.invited_count}</strong></div>
          <div class="muted">邀请人：${escapeHtml(row.inviter_username ?? row.inviter_phone ?? row.inviter_nickname ?? "-")}</div>
        </td>
        <td>${renderPlanCell(row.active_plan_id ?? "-", row.active_plan_name)}</td>
        <td>${formatDateTime(row.active_subscription_expires_at)}</td>
        <td>${row.subscription_count}</td>
        <td>${row.order_count}</td>
        <td>${row.active_session_count}</td>
        <td>${formatDateTime(row.created_at)}</td>
      </tr>`).join("");
    res.type("html").send(renderLayout("用户列表", `
      <h2>用户列表与邀请关系</h2>
      <form class="toolbar" method="get">
        <label>搜索<input name="q" value="${escapeHtml(search)}" placeholder="手机号 / 用户名 / 昵称 / 邀请码 / user_id" /></label>
        <label>每页<input name="limit" value="${limit}" /></label>
        <button type="submit">筛选</button>
      </form>
      <div class="table-wrap"><table><thead><tr><th>用户</th><th>手机号</th><th>用户名</th><th>昵称</th><th>邀请码</th><th>邀请情况</th><th>当前套餐</th><th>到期时间</th><th>订阅数</th><th>订单数</th><th>会话数</th><th>创建时间</th></tr></thead><tbody>${rows || '<tr><td colspan="12" class="empty">暂无用户</td></tr>'}</tbody></table></div>
      ${renderPagination(`${config.rootPath}/users`, params, page.total, limit, offset)}
    `, config.rootPath));
  });

  router.get("/users/:id", async (req, res) => {
    try {
      const detail = await fetchUserDetail(req.params.id);
      const flash = renderFlash(new URLSearchParams(String(req.url.split("?")[1] ?? "")));
      const subscriptionRows = detail.subscriptions.map((row) => `
        <tr>
          <td><code>${escapeHtml(row.id)}</code></td>
          <td>${renderPlanCell(row.plan_id, row.plan_name)}</td>
          <td>${formatDateTime(row.starts_at)}</td>
          <td>${formatDateTime(row.expires_at)}</td>
          <td>${renderPill(row.is_active ? "active" : "expired")}</td>
          <td>${formatDateTime(row.created_at)}</td>
        </tr>`).join("");
      const orderRows = detail.orders.map((row) => `
        <tr>
          <td><a href="${config.rootPath}/membership-orders/${row.id}"><code>${escapeHtml(row.order_no)}</code></a></td>
          <td>${renderPlanCell(row.plan_id, row.plan_name)}</td>
          <td>${formatMoney(row.amount_cents, row.currency)}</td>
          <td>${renderPill(row.status)}</td>
          <td>${renderPill(row.review_status)}</td>
          <td>${renderPill(row.grant_status)}</td>
          <td>${formatDateTime(row.created_at)}</td>
        </tr>`).join("");
      const grantRows = detail.grants.map((row) => `
        <tr>
          <td><a href="${config.rootPath}/membership-orders/${row.order_id}">${escapeHtml(row.order_no)}</a></td>
          <td>${renderPlanCell(row.plan_id, row.plan_name)}</td>
          <td>${renderPill(row.grant_status)}</td>
          <td>${row.subscription_is_active ? renderPill("active") : renderPill("expired")}</td>
          <td>${formatDateTime(row.starts_at)}</td>
          <td>${formatDateTime(row.expires_at)}</td>
        </tr>`).join("");
      const invitedUserRows = detail.invitedUsers.map((row) => `
        <tr>
          <td>${renderUserCell(config.rootPath, row.id, row)}</td>
          <td>${escapeHtml(row.phone ?? "-")}</td>
          <td>${escapeHtml(row.username ?? "-")}</td>
          <td>${escapeHtml(row.nickname ?? "-")}</td>
          <td>${formatDateTime(row.invited_at)}</td>
          <td>${formatDateTime(row.created_at)}</td>
        </tr>`).join("");
      const sessionRows = detail.sessions.map((row) => {
        const state = getAuthSessionState(row);
        const returnTo = `${config.rootPath}/users/${detail.user.id}`;
        return `
          <tr>
            <td><code>${escapeHtml(row.id)}</code></td>
            <td>${escapeHtml(row.device_name ?? row.device_id ?? row.platform ?? "-")}${row.user_agent ? `<div class="muted">${escapeHtml(truncate(row.user_agent, 88))}</div>` : ""}</td>
            <td>${escapeHtml(row.last_ip ?? "-")}</td>
            <td>${formatDateTime(row.last_seen_at)}</td>
            <td>${formatDateTime(row.refresh_expires_at)}</td>
            <td>${renderPill(state)}</td>
            <td>
              ${state === "active"
                ? `<form class="inline-form" method="post" action="${config.rootPath}/auth-sessions/${row.id}/revoke"><input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}" /><button type="submit" class="secondary">撤销</button></form>`
                : '<span class="muted">-</span>'}
            </td>
          </tr>`;
      }).join("");

      const infoRow = (label: string, value: string) => `<div>${escapeHtml(label)}</div><div>${value}</div>`;
      const extraCredits = Math.max(0, Math.trunc(detail.user.extra_business_message_credits ?? 0));
      res.type("html").send(renderLayout(`用户 ${detail.user.username ?? detail.user.phone ?? detail.user.id}`, `
        <h2>用户详情</h2>
        ${flash}
        <div class="split">
          <div class="card">
            <h3>基础信息</h3>
            <div class="kv">
              ${infoRow("用户 ID", `<code>${escapeHtml(detail.user.id)}</code>`)}
              ${infoRow("手机号", escapeHtml(detail.user.phone ?? "-"))}
              ${infoRow("用户名", escapeHtml(detail.user.username ?? "-"))}
              ${infoRow("昵称", escapeHtml(detail.user.nickname ?? "-"))}
              ${infoRow("微信 OpenID", escapeHtml(detail.user.wechat_openid ?? "-"))}
              ${infoRow("额外业务次数余额", `<strong>${extraCredits}</strong>`)}
              ${infoRow("我的邀请码", `<code>${escapeHtml(detail.invitationSummary.inviteCode)}</code>`)}
              ${infoRow("邀请人", detail.invitationSummary.inviter ? renderUserCell(config.rootPath, detail.invitationSummary.inviter.id, detail.invitationSummary.inviter) : "-")}
              ${infoRow("绑定邀请时间", escapeHtml(formatDateTime(detail.invitationSummary.invitedAt)))}
              ${infoRow("头像地址", detail.user.avatar_url ? `<a href="${escapeHtml(detail.user.avatar_url)}" target="_blank">${escapeHtml(detail.user.avatar_url)}</a>` : "-")}
              ${infoRow("创建时间", escapeHtml(formatDateTime(detail.user.created_at)))}
              ${infoRow("更新时间", escapeHtml(formatDateTime(detail.user.updated_at)))}
            </div>
            <div class="actions">
              <a class="btn secondary" href="${config.rootPath}/membership-orders?q=${encodeURIComponent(detail.user.id)}">查该用户订单</a>
              <a class="btn secondary" href="${config.rootPath}/auth-sessions?q=${encodeURIComponent(detail.user.id)}">查该用户会话</a>
            </div>
          </div>
          <div class="panel-stack">
            <div class="card">
              <h3>当前会员状态</h3>
              ${detail.activeSubscription ? `
                <div class="kv">
                  ${infoRow("套餐", renderPlanCell(detail.activeSubscription.plan_id, detail.activeSubscription.plan_name))}
                  ${infoRow("价格", escapeHtml(formatMoney(detail.activeSubscription.price_cents ?? null)))}
                  ${infoRow("时长（天）", escapeHtml(String(detail.activeSubscription.duration_days ?? "-")))}
                  ${infoRow("开始时间", escapeHtml(formatDateTime(detail.activeSubscription.starts_at)))}
                  ${infoRow("到期时间", escapeHtml(formatDateTime(detail.activeSubscription.expires_at)))}
                </div>
                <h3 style="margin-top:16px;">功能配置</h3>
                ${renderFeatures(detail.activeSubscription.features)}
              ` : '<div class="empty">当前无有效会员订阅</div>'}
            </div>
            <div class="card">
              <h3>运营提示</h3>
              <ul class="compact">
                <li>邀请码：<code>${escapeHtml(detail.invitationSummary.inviteCode)}</code></li>
                <li>已邀请用户：<strong>${detail.invitationSummary.invitedCount}</strong></li>
                <li>邀请奖励已发放：<strong>${detail.inviteRewardSummary.grantedCount}</strong> 次</li>
                <li>邀请奖励累计送出：<strong>${detail.inviteRewardSummary.totalRewardDays} 天</strong></li>
                <li>近 12 条订单：<strong>${detail.orders.length}</strong></li>
                <li>近 12 条权益发放：<strong>${detail.grants.length}</strong></li>
                <li>近 20 条设备会话：<strong>${detail.sessions.length}</strong></li>
              </ul>
              ${detail.inviteRewardSummary.latestReward ? `
                <div class="muted" style="margin-top:12px;">
                  最近一次奖励：${escapeHtml(detail.inviteRewardSummary.latestReward.policyName)}
                  · ${escapeHtml(formatPlanDuration(detail.inviteRewardSummary.latestReward.rewardDurationDays))}
                  · ${escapeHtml(formatDateTime(detail.inviteRewardSummary.latestReward.grantedAt))}
                </div>
              ` : '<div class="muted" style="margin-top:12px;">暂无邀请奖励发放记录</div>'}
            </div>
            <div class="card">
              <h3>管理员操作区</h3>
              <div class="muted">仅管理员后台可见；这里的操作会直接影响该用户会员和业务次数余额。</div>
              <div class="kv" style="margin-top:16px;">
                ${infoRow("当前额外业务次数余额", `<strong>${extraCredits}</strong>`)}
                ${infoRow("当前有效会员", detail.activeSubscription ? renderPlanCell(detail.activeSubscription.plan_id, detail.activeSubscription.plan_name) : "无")}
              </div>
              <h4 style="margin-top:16px;">延长会员</h4>
              <form method="post" action="${config.rootPath}/users/${detail.user.id}/extend-membership">
                <label>延长天数<input name="days" value="30" inputmode="numeric" required /></label>
                <button type="submit">延长会员</button>
              </form>
              <h4 style="margin-top:16px;">增加使用次数</h4>
              <form method="post" action="${config.rootPath}/users/${detail.user.id}/add-business-credits">
                <label>增加次数<input name="credits" value="10" inputmode="numeric" required /></label>
                <button type="submit">增加余额</button>
              </form>
            </div>
          </div>
        </div>

        <div class="card" style="margin-top:16px;">
          <div class="section-title"><h3>订阅历史</h3><span class="muted">最近 12 条</span></div>
          <div class="table-wrap"><table><thead><tr><th>ID</th><th>套餐</th><th>开始时间</th><th>到期时间</th><th>状态</th><th>创建时间</th></tr></thead><tbody>${subscriptionRows || '<tr><td colspan="6" class="empty">暂无订阅记录</td></tr>'}</tbody></table></div>
        </div>

        <div class="card" style="margin-top:16px;">
          <div class="section-title"><h3>订单记录</h3><span class="muted">最近 12 条</span></div>
          <div class="table-wrap"><table><thead><tr><th>订单号</th><th>套餐</th><th>金额</th><th>状态</th><th>审核</th><th>发放</th><th>创建时间</th></tr></thead><tbody>${orderRows || '<tr><td colspan="7" class="empty">暂无订单记录</td></tr>'}</tbody></table></div>
        </div>

        <div class="card" style="margin-top:16px;">
          <div class="section-title"><h3>权益发放记录</h3><span class="muted">最近 12 条</span></div>
          <div class="table-wrap"><table><thead><tr><th>订单号</th><th>套餐</th><th>发放状态</th><th>订阅状态</th><th>开始时间</th><th>到期时间</th></tr></thead><tbody>${grantRows || '<tr><td colspan="6" class="empty">暂无权益发放记录</td></tr>'}</tbody></table></div>
        </div>

        <div class="card" style="margin-top:16px;">
          <div class="section-title"><h3>邀请明细</h3><span class="muted">邀请码注册绑定的用户</span></div>
          <div class="table-wrap"><table><thead><tr><th>被邀请用户</th><th>手机号</th><th>用户名</th><th>昵称</th><th>绑定时间</th><th>注册时间</th></tr></thead><tbody>${invitedUserRows || '<tr><td colspan="6" class="empty">暂无邀请记录</td></tr>'}</tbody></table></div>
        </div>

        <div class="card" style="margin-top:16px;">
          <div class="section-title"><h3>邀请奖励记录</h3><span class="muted">最近 5 条自动发放记录</span></div>
          <div class="table-wrap"><table><thead><tr><th>规则</th><th>触发条件</th><th>奖励时长</th><th>会员到期</th><th>状态</th><th>发放时间</th></tr></thead><tbody>${
            detail.inviteRewardSummary.recentRewards.map((reward) => `
              <tr>
                <td>${escapeHtml(reward.policyName)}</td>
                <td>${escapeHtml(formatInviteRewardGrantTrigger({
                  trigger_type: reward.triggerType,
                  trigger_invited_count: reward.triggerInvitedCount,
                }))}</td>
                <td>${escapeHtml(formatPlanDuration(reward.rewardDurationDays))}</td>
                <td>${escapeHtml(formatDateTime(reward.subscriptionExpiresAt))}</td>
                <td>${renderPill(reward.status)}</td>
                <td>${escapeHtml(formatDateTime(reward.grantedAt))}</td>
              </tr>`).join("") || '<tr><td colspan="6" class="empty">暂无邀请奖励记录</td></tr>'
          }</tbody></table></div>
        </div>

        <div class="card" style="margin-top:16px;">
          <div class="section-title"><h3>设备会话</h3><span class="muted">最近 20 条</span></div>
          <div class="table-wrap"><table><thead><tr><th>会话 ID</th><th>设备</th><th>IP</th><th>最后活跃</th><th>刷新令牌到期</th><th>状态</th><th>操作</th></tr></thead><tbody>${sessionRows || '<tr><td colspan="7" class="empty">暂无设备会话</td></tr>'}</tbody></table></div>
        </div>
      `, config.rootPath));
    } catch (error) {
      res.status(404).type("html").send(renderLayout("用户不存在", `<div class="flash error">${escapeHtml(error instanceof Error ? error.message : String(error))}</div>`, config.rootPath));
    }
  });

  router.get("/plans", async (req, res) => {
    const rows = await listPlanStats();
    const flash = renderFlash(new URLSearchParams(String(req.url.split("?")[1] ?? "")));
    const cards = rows.map((row) => `
      <div class="card">
        <div class="kicker">${escapeHtml(row.id)} · ${row.is_active ? "上架中" : "已下架"}</div>
        <h2>${escapeHtml(row.name)}${row.badge_text ? ` <span class="pill">${escapeHtml(row.badge_text)}</span>` : ""}</h2>
        <div class="stat-number">${formatMoney(row.price_cents)}</div>
        <div class="stat-label">时长：${formatPlanDuration(row.duration_days)}</div>
        <div class="muted" style="margin-top:10px;">${escapeHtml(row.description ?? "未填写展示文案")}</div>
        <div style="margin-top:12px;">${renderFeatures(row.features)}</div>
        <div class="kv" style="margin-top:16px;">
          <div>角标文案</div><div>${escapeHtml(row.badge_text ?? "-")}</div>
          <div>支付商品标识</div><div>${escapeHtml(formatPlanPaymentGoodsKey(row))}</div>
          <div>排序值</div><div>${row.sort_order}</div>
          <div>销售状态</div><div>${row.is_active ? "上架中" : "已下架"}</div>
          <div>总订阅数</div><div>${row.subscription_count}</div>
          <div>有效订阅数</div><div>${row.active_subscription_count}</div>
          <div>订单数</div><div>${row.order_count}</div>
          <div>已发放订单数</div><div>${row.fulfilled_order_count}</div>
          <div>发放记录数</div><div>${row.grant_count}</div>
        </div>
        <h3 style="margin-top:18px;">编辑套餐</h3>
        <form method="post" action="${config.rootPath}/plans/${encodeURIComponent(row.id)}">
          <label>套餐名称<input name="name" value="${escapeHtml(row.name)}" required /></label>
          <label>展示角标<input name="badgeText" value="${escapeHtml(row.badge_text ?? "")}" placeholder="如：推荐 / 热销 / 年付" /></label>
          <label>展示文案<textarea name="description" placeholder="前端/后台展示的套餐说明">${escapeHtml(row.description ?? "")}</textarea></label>
          <label>价格（分）<input name="priceCents" value="${row.price_cents}" inputmode="numeric" required /></label>
          <div class="muted">例如：300 = 3 元，2900 = 29 元</div>
          <label>会员时长（天，0 表示长期）<input name="durationDays" value="${row.duration_days}" inputmode="numeric" required /></label>
          <div class="muted">常用：1 = 1 天，30 = 1 个月，365 = 1 年</div>
          <label>支付商品标识 / goods key<input name="paymentGoodsKey" value="${escapeHtml(formatPlanPaymentGoodsKey(row) === "-" ? "" : formatPlanPaymentGoodsKey(row))}" placeholder="例如：6idmbq" /></label>
          <div class="muted">填写链动小铺的明确商品标识后，后端创建支付订单时会优先使用它。</div>
          <label>展示排序（越小越靠前）<input name="sortOrder" value="${row.sort_order}" inputmode="numeric" required /></label>
          <label><input type="checkbox" name="isActive" ${row.is_active ? "checked" : ""} /> 上架并允许前台展示/售卖</label>
          <label>功能配置（JSON）<textarea name="features">${escapeHtml(JSON.stringify(row.features ?? {}, null, 2))}</textarea></label>
          <div class="actions">
            <button type="submit">保存套餐配置</button>
          </div>
        </form>
      </div>`).join("");
    const tableRows = rows.map((row) => `
      <tr>
        <td>${renderPlanCell(row.id, row.name)}</td>
        <td>${escapeHtml(row.badge_text ?? "-")}</td>
        <td>${formatMoney(row.price_cents)}</td>
        <td>${formatPlanDuration(row.duration_days)}</td>
        <td>${row.sort_order}</td>
        <td>${row.is_active ? renderPill("active") : renderPill("cancelled")}</td>
        <td>${escapeHtml(row.description ?? "-")}</td>
        <td>${escapeHtml(formatPlanPaymentGoodsKey(row))}</td>
        <td>${renderFeatures(row.features)}</td>
        <td>${row.active_subscription_count} / ${row.subscription_count}</td>
        <td>${row.fulfilled_order_count} / ${row.order_count}</td>
        <td>${row.grant_count}</td>
      </tr>`).join("");
    res.type("html").send(renderLayout("套餐配置", `
      <h2>会员套餐配置</h2>
      ${flash}
      <div class="card" style="margin-bottom:16px;">
        <h3>套餐配置说明</h3>
        <ul class="compact">
          <li>价格单位为<strong>分</strong>，例如 300 表示 3 元，2900 表示 29 元。</li>
          <li>时长单位为<strong>天</strong>，例如 1 = 1 天，30 = 1 个月，365 = 1 年，0 = 长期/不限时。</li>
          <li>关闭“上架并允许前台展示/售卖”后，该套餐不会在前端展示给用户。</li>
          <li>“支付商品标识 / goods key” 用来把套餐显式绑定到链动小铺商品，优先级高于环境变量映射和按金额匹配。</li>
          <li>功能配置 JSON 可继续控制免费额度、会员能力、标签等扩展字段。</li>
        </ul>
      </div>
      <div class="grid">${cards || '<div class="card empty">暂无套餐</div>'}</div>
      <div class="card">
        <div class="section-title"><h3>套餐统计总览</h3><span class="muted">价格、时长、文案、开关都可以在本页直接修改</span></div>
        <div class="table-wrap"><table><thead><tr><th>套餐</th><th>角标</th><th>价格</th><th>时长</th><th>排序</th><th>状态</th><th>展示文案</th><th>支付商品标识</th><th>功能配置</th><th>订阅</th><th>订单</th><th>发放</th></tr></thead><tbody>${tableRows || '<tr><td colspan="12" class="empty">暂无数据</td></tr>'}</tbody></table></div>
      </div>
    `, config.rootPath));
  });

  router.post("/plans/:id", async (req, res) => {
    const target = `${config.rootPath}/plans`;
    try {
      const planId = req.params.id;
      const existing = await getPlanById(planId);
      if (!existing) {
        redirectWithMessage(res, target, "error", "套餐不存在");
        return;
      }

      const name = String(req.body.name || "").trim();
      if (!name) {
        redirectWithMessage(res, target, "error", "套餐名称不能为空");
        return;
      }

      const priceCents = parseIntegerAtLeast(req.body.priceCents, 0);
      if (priceCents === null) {
        redirectWithMessage(res, target, "error", "价格（分）必须是大于等于 0 的整数");
        return;
      }

      const durationDays = parseIntegerAtLeast(req.body.durationDays, 0);
      if (durationDays === null) {
        redirectWithMessage(res, target, "error", "会员时长必须是大于等于 0 的整数");
        return;
      }

      const sortOrder = parseIntegerAtLeast(req.body.sortOrder, 0);
      if (sortOrder === null) {
        redirectWithMessage(res, target, "error", "展示排序必须是大于等于 0 的整数");
        return;
      }

      const features = withPlanPaymentGoodsKey(
        parseJsonObject(req.body.features),
        String(req.body.paymentGoodsKey || "").trim() || null,
      );
      const updated = await updatePlan(planId, {
        name,
        badge_text: String(req.body.badgeText || "").trim() || null,
        description: String(req.body.description || "").trim() || null,
        price_cents: priceCents,
        duration_days: durationDays,
        sort_order: sortOrder,
        is_active: parseCheckbox(req.body.isActive),
        features,
      });

      if (!updated) {
        redirectWithMessage(res, target, "error", "套餐更新失败");
        return;
      }

      redirectWithMessage(res, target, "ok", `套餐「${updated.name}」已更新`);
    } catch (error) {
      redirectWithMessage(res, target, "error", error instanceof Error ? error.message : String(error));
    }
  });

  router.get("/subscriptions", async (req, res) => {
    const params = new URLSearchParams(req.query as Record<string, string>);
    const limit = parsePageSize(req.query.limit, 20);
    const offset = parseOffset(req.query.offset);
    const search = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const page = await listSubscriptions(limit, offset, search);
    const rows = page.rows.map((row) => `
      <tr>
        <td><code>${escapeHtml(row.id)}</code></td>
        <td>${renderUserCell(config.rootPath, row.user_id, row)}</td>
        <td>${renderPlanCell(row.plan_id, row.plan_name)}</td>
        <td>${formatDateTime(row.starts_at)}</td>
        <td>${formatDateTime(row.expires_at)}</td>
        <td>${row.is_active ? renderPill("active") : renderPill("expired")}</td>
        <td>${formatDateTime(row.created_at)}</td>
      </tr>`).join("");
    res.type("html").send(renderLayout("订阅列表", `
      <h2>订阅列表</h2>
      <form class="toolbar" method="get">
        <label>搜索<input name="q" value="${escapeHtml(search)}" placeholder="用户 / 手机号 / 套餐 / 订阅 ID" /></label>
        <label>每页<input name="limit" value="${limit}" /></label>
        <button type="submit">筛选</button>
      </form>
      <div class="table-wrap"><table><thead><tr><th>ID</th><th>用户</th><th>套餐</th><th>开始时间</th><th>到期时间</th><th>状态</th><th>创建时间</th></tr></thead><tbody>${rows || '<tr><td colspan="7" class="empty">暂无订阅</td></tr>'}</tbody></table></div>
      ${renderPagination(`${config.rootPath}/subscriptions`, params, page.total, limit, offset)}
    `, config.rootPath));
  });

  router.get("/membership-orders", async (req, res) => {
    const params = new URLSearchParams(req.query as Record<string, string>);
    const limit = parsePageSize(req.query.limit, 20);
    const offset = parseOffset(req.query.offset);
    const search = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const status = typeof req.query.status === "string" ? req.query.status.trim() : "";
    const reviewStatus = typeof req.query.review_status === "string" ? req.query.review_status.trim() : "";
    const page = await listMembershipOrders(limit, offset, search, status, reviewStatus);
    const rows = page.rows.map((row) => `
      <tr>
        <td><a href="${config.rootPath}/membership-orders/${row.id}"><code>${escapeHtml(row.order_no)}</code></a></td>
        <td>${renderUserCell(config.rootPath, row.user_id, row)}</td>
        <td>${renderPlanCell(row.plan_id, row.plan_name)}</td>
        <td>${formatMoney(row.amount_cents, row.currency)}</td>
        <td>${renderPill(row.status)}</td>
        <td>${renderPill(row.review_status)}</td>
        <td>${renderPill(row.latest_payment_status)}</td>
        <td>${renderPill(row.grant_status)}</td>
        <td>${escapeHtml(row.client_reference ?? "-")}</td>
        <td>${formatDateTime(row.created_at)}</td>
      </tr>`).join("");
    res.type("html").send(renderLayout("会员订单", `
      <h2>会员订单</h2>
      ${renderFlash(params)}
      <form class="toolbar" method="get">
        <label>搜索<input name="q" value="${escapeHtml(search)}" placeholder="订单号 / 用户 / 手机号 / 客户端关联号" /></label>
        <label>订单状态<select name="status"><option value="">全部状态</option>${renderSelectOptions(status, [
          { value: "pending", label: "待处理" },
          { value: "paid", label: "已支付" },
          { value: "review_required", label: "待复核" },
          { value: "fulfilled", label: "已发放" },
          { value: "cancelled", label: "已取消" },
        ])}</select></label>
        <label>审核状态<select name="review_status"><option value="">全部审核状态</option>${renderSelectOptions(reviewStatus, [
          { value: "pending_review", label: "待审核" },
          { value: "approved", label: "已通过" },
          { value: "rejected", label: "已拒绝" },
        ])}</select></label>
        <label>每页<input name="limit" value="${limit}" /></label>
        <button type="submit">筛选</button>
      </form>
      <div class="table-wrap"><table><thead><tr><th>订单号</th><th>用户</th><th>套餐</th><th>金额</th><th>订单状态</th><th>审核状态</th><th>最新支付</th><th>发放状态</th><th>关联号</th><th>创建时间</th></tr></thead><tbody>${rows || '<tr><td colspan="10" class="empty">暂无数据</td></tr>'}</tbody></table></div>
      ${renderPagination(`${config.rootPath}/membership-orders`, params, page.total, limit, offset)}
    `, config.rootPath));
  });

  router.get("/membership-orders/:id", async (req, res) => {
    try {
      const detail = await fetchOrderDetail(req.params.id);
      const flash = renderFlash(new URLSearchParams(String(req.url.split("?")[1] ?? "")));
      const paymentsTable = detail.payments.map((payment) => `
        <tr>
          <td><code>${escapeHtml(payment.id)}</code></td>
          <td>${escapeHtml(payment.channel)} / ${escapeHtml(payment.provider)}</td>
          <td>${formatMoney(payment.amount_cents, payment.currency)}</td>
          <td>${renderPill(payment.status)}</td>
          <td>${renderPill(payment.review_status)}</td>
          <td>${escapeHtml(payment.provider_transaction_id ?? "-")}</td>
          <td>${escapeHtml(payment.review_note ?? "-")}</td>
          <td>${formatDateTime(payment.paid_at)}</td>
          <td>${formatDateTime(payment.created_at)}</td>
        </tr>`).join("");

      const infoRow = (label: string, value: string) => `<div>${escapeHtml(label)}</div><div>${value}</div>`;
      res.type("html").send(renderLayout(`订单 ${detail.order.order_no}`, `
        <h2>订单详情：${escapeHtml(detail.order.order_no)}</h2>
        ${flash}
        <div class="actions" style="margin-bottom:16px;">
          ${detail.user ? `<a class="btn secondary" href="${config.rootPath}/users/${detail.user.id}">查看用户详情</a>` : ""}
          <a class="btn secondary" href="${config.rootPath}/membership-orders">返回订单列表</a>
        </div>
        <div class="split">
          <div class="card">
            <h3>订单信息</h3>
            <div class="kv">
              ${infoRow("订单 ID", `<code>${escapeHtml(detail.order.id)}</code>`)}
              ${infoRow("用户", detail.user ? renderUserCell(config.rootPath, detail.order.user_id, detail.user) : `<code>${escapeHtml(detail.order.user_id)}</code>`)}
              ${infoRow("套餐", renderPlanCell(detail.order.plan_id, detail.plan?.name ?? detail.order.title))}
              ${infoRow("金额", escapeHtml(formatMoney(detail.order.amount_cents, detail.order.currency)))}
              ${infoRow("订单状态", renderPill(detail.order.status))}
              ${infoRow("审核状态", renderPill(detail.order.review_status))}
              ${infoRow("审核原因", escapeHtml(detail.order.review_reason ?? "-"))}
              ${infoRow("支付渠道", escapeHtml(detail.order.payment_channel ?? "-"))}
              ${infoRow("客户端关联号", escapeHtml(detail.order.client_reference ?? "-"))}
              ${infoRow("幂等键", escapeHtml(detail.order.idempotency_key ?? "-"))}
              ${infoRow("过期时间", escapeHtml(formatDateTime(detail.order.expires_at)))}
              ${infoRow("支付时间", escapeHtml(formatDateTime(detail.order.paid_at)))}
              ${infoRow("发放时间", escapeHtml(formatDateTime(detail.order.fulfilled_at)))}
              ${infoRow("创建时间", escapeHtml(formatDateTime(detail.order.created_at)))}
              ${infoRow("更新时间", escapeHtml(formatDateTime(detail.order.updated_at)))}
            </div>
            <h3 style="margin-top:16px;">订单元数据</h3>
            ${renderJson(detail.order.metadata ?? {})}
            <h3 style="margin-top:16px;">套餐配置</h3>
            ${detail.plan ? renderFeatures(detail.plan.features) : '<div class="empty">未找到套餐配置</div>'}
          </div>
          <div>
            <div class="card" style="margin-bottom:16px;">
              <h3>手动标记已支付</h3>
              <form method="post" action="${config.rootPath}/membership-orders/${detail.order.id}/mark-paid">
                <label>操作人<input name="operator" value="${escapeHtml(config.basicAuthUser ?? "admin")}" /></label>
                <label>渠道<input name="channel" value="manual" /></label>
                <label>提供方<input name="provider" value="admin" /></label>
                <label>支付流水号<input name="providerTransactionId" placeholder="可留空" /></label>
                <label>金额（分）<input name="amountCents" value="${detail.order.amount_cents}" /></label>
                <label>币种<input name="currency" value="${escapeHtml(detail.order.currency)}" /></label>
                <label>审核备注<textarea name="reviewNote" placeholder="可选备注"></textarea></label>
                <button type="submit">执行手动标记已支付</button>
              </form>
            </div>
            <div class="card" style="margin-bottom:16px;">
              <h3>转入人工复核</h3>
              <form method="post" action="${config.rootPath}/membership-orders/${detail.order.id}/manual-review">
                <label>复核人<input name="reviewer" value="${escapeHtml(config.basicAuthUser ?? "admin")}" /></label>
                <label>复核原因<textarea name="reason" placeholder="请填写复核原因" required></textarea></label>
                <label>备注<textarea name="note" placeholder="可选支付备注"></textarea></label>
                <button type="submit">标记待复核</button>
              </form>
            </div>
            <div class="card">
              <h3>通过复核</h3>
              <form method="post" action="${config.rootPath}/membership-orders/${detail.order.id}/approve-review">
                <label>复核人<input name="reviewer" value="${escapeHtml(config.basicAuthUser ?? "admin")}" /></label>
                <label>审批备注<textarea name="note" placeholder="审批备注，可选"></textarea></label>
                <button type="submit">通过复核并发放会员</button>
              </form>
            </div>
          </div>
        </div>
        <div class="card" style="margin-top:16px;">
          <h3>支付流水</h3>
          <div class="table-wrap"><table><thead><tr><th>ID</th><th>渠道 / 提供方</th><th>金额</th><th>状态</th><th>审核</th><th>支付流水号</th><th>审核备注</th><th>支付时间</th><th>创建时间</th></tr></thead><tbody>${paymentsTable || '<tr><td colspan="9" class="empty">暂无支付流水</td></tr>'}</tbody></table></div>
        </div>
        <div class="grid" style="margin-top:16px;">
          <div class="card"><h3>权益发放记录</h3>${renderJson(detail.grant ?? null)}</div>
          <div class="card"><h3>订阅记录</h3>${renderJson(detail.subscription ?? null)}</div>
        </div>
      `, config.rootPath));
    } catch (error) {
      res.status(404).type("html").send(renderLayout("订单不存在", `<div class="flash error">${escapeHtml(error instanceof Error ? error.message : String(error))}</div>`, config.rootPath));
    }
  });

  router.post("/membership-orders/:id/mark-paid", async (req, res) => {
    const target = `${config.rootPath}/membership-orders/${req.params.id}`;
    try {
      const amountCents = parsePositiveInt(req.body.amountCents);
      if (amountCents === null) {
        redirectWithMessage(res, target, "error", "金额（分）必须为正整数");
        return;
      }
      const result = await markMembershipOrderPaid({
        orderId: req.params.id,
        channel: String(req.body.channel || "manual"),
        provider: String(req.body.provider || "admin"),
        providerTransactionId: req.body.providerTransactionId ? String(req.body.providerTransactionId) : undefined,
        amountCents,
        currency: req.body.currency ? String(req.body.currency) : undefined,
        operator: req.body.operator ? String(req.body.operator) : undefined,
        reviewNote: req.body.reviewNote ? String(req.body.reviewNote) : undefined,
      });
      if (!result) {
        redirectWithMessage(res, target, "error", "订单不存在");
        return;
      }
      redirectWithMessage(res, target, "ok", `手动标记已支付成功，当前状态：${result.order.status}`);
    } catch (error) {
      redirectWithMessage(res, target, "error", error instanceof Error ? error.message : String(error));
    }
  });

  router.post("/membership-orders/:id/manual-review", async (req, res) => {
    const target = `${config.rootPath}/membership-orders/${req.params.id}`;
    try {
      const reason = String(req.body.reason || "").trim();
      if (!reason) {
        redirectWithMessage(res, target, "error", "复核原因不能为空");
        return;
      }
      const reviewer = String(req.body.reviewer || config.basicAuthUser || "admin");
      const note = req.body.note ? String(req.body.note) : undefined;
      const paymentId = await ensureReviewPaymentRecord(req.params.id, reviewer, reason, note);
      const result = await markMembershipOrderForManualReview({
        orderId: req.params.id,
        reviewer,
        reason,
        note,
        paymentId: paymentId ?? undefined,
      });
      if (!result) {
        redirectWithMessage(res, target, "error", "订单不存在");
        return;
      }
      redirectWithMessage(res, target, "ok", `已标记为待复核：${result.order.review_status}`);
    } catch (error) {
      redirectWithMessage(res, target, "error", error instanceof Error ? error.message : String(error));
    }
  });

  router.post("/membership-orders/:id/approve-review", async (req, res) => {
    const target = `${config.rootPath}/membership-orders/${req.params.id}`;
    try {
      const result = await approveMembershipOrderReview(
        req.params.id,
        String(req.body.reviewer || config.basicAuthUser || "admin"),
        req.body.note ? String(req.body.note) : undefined,
      );
      if (!result) {
        redirectWithMessage(res, target, "error", "订单不存在");
        return;
      }
      redirectWithMessage(res, target, "ok", `通过复核成功，当前状态：${result.order.status}`);
    } catch (error) {
      redirectWithMessage(res, target, "error", error instanceof Error ? error.message : String(error));
    }
  });

  router.post("/users/:id/extend-membership", async (req, res) => {
    const target = `${config.rootPath}/users/${req.params.id}`;
    try {
      const days = parsePositiveInt(req.body.days);
      if (days === null) {
        redirectWithMessage(res, target, "error", "延长天数必须为正整数");
        return;
      }

      const user = await query<User>("SELECT id FROM users WHERE id = $1", [req.params.id]);
      if (!user.rows[0]) {
        redirectWithMessage(res, target, "error", "用户不存在");
        return;
      }

      const subscription = await extendSubscription(req.params.id, days);
      redirectWithMessage(
        res,
        target,
        "ok",
        subscription.expires_at
          ? `会员已延长 ${days} 天，新的到期时间：${formatDateTime(subscription.expires_at)}`
          : `会员已更新，当前为长期会员`,
      );
    } catch (error) {
      redirectWithMessage(res, target, "error", error instanceof Error ? error.message : String(error));
    }
  });

  router.post("/users/:id/add-business-credits", async (req, res) => {
    const target = `${config.rootPath}/users/${req.params.id}`;
    try {
      const credits = parsePositiveInt(req.body.credits);
      if (credits === null) {
        redirectWithMessage(res, target, "error", "增加次数必须为正整数");
        return;
      }

      const user = await query<User>("SELECT id FROM users WHERE id = $1", [req.params.id]);
      if (!user.rows[0]) {
        redirectWithMessage(res, target, "error", "用户不存在");
        return;
      }

      const updated = await addUserBusinessMessageCredits(req.params.id, credits);
      redirectWithMessage(
        res,
        target,
        "ok",
        `已增加 ${credits} 次，当前额外业务次数余额：${updated?.extra_business_message_credits ?? 0}`,
      );
    } catch (error) {
      redirectWithMessage(res, target, "error", error instanceof Error ? error.message : String(error));
    }
  });

  router.get("/order-payments", async (req, res) => {
    const params = new URLSearchParams(req.query as Record<string, string>);
    const limit = parsePageSize(req.query.limit, 20);
    const offset = parseOffset(req.query.offset);
    const search = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const status = typeof req.query.status === "string" ? req.query.status.trim() : "";
    const reviewStatus = typeof req.query.review_status === "string" ? req.query.review_status.trim() : "";
    const page = await listOrderPayments(limit, offset, search, status, reviewStatus);
    const rows = page.rows.map((row) => `
      <tr>
        <td><code>${escapeHtml(row.id)}</code></td>
        <td><a href="${config.rootPath}/membership-orders/${row.order_id}">${escapeHtml(row.order_no)}</a></td>
        <td>${renderUserCell(config.rootPath, row.user_id, row)}</td>
        <td>${escapeHtml(row.channel)} / ${escapeHtml(row.provider)}</td>
        <td>${formatMoney(row.amount_cents, row.currency)}</td>
        <td>${renderPill(row.status)}</td>
        <td>${renderPill(row.review_status)}</td>
        <td>${escapeHtml(row.provider_transaction_id ?? "-")}</td>
        <td>${escapeHtml(row.review_note ?? "-")}</td>
        <td>${formatDateTime(row.created_at)}</td>
      </tr>`).join("");
    res.type("html").send(renderLayout("支付流水", `
      <h2>支付流水</h2>
      <form class="toolbar" method="get">
        <label>搜索<input name="q" value="${escapeHtml(search)}" placeholder="支付单 / 订单号 / 流水号 / 手机号" /></label>
        <label>支付状态<select name="status"><option value="">全部支付状态</option>${renderSelectOptions(status, [
          { value: "success", label: "成功" },
          { value: "review_required", label: "待复核" },
          { value: "failed", label: "失败" },
          { value: "pending", label: "待处理" },
        ])}</select></label>
        <label>审核状态<select name="review_status"><option value="">全部审核状态</option>${renderSelectOptions(reviewStatus, [
          { value: "pending_review", label: "待审核" },
          { value: "approved", label: "已通过" },
          { value: "rejected", label: "已拒绝" },
        ])}</select></label>
        <label>每页<input name="limit" value="${limit}" /></label>
        <button type="submit">筛选</button>
      </form>
      <div class="table-wrap"><table><thead><tr><th>ID</th><th>订单号</th><th>用户</th><th>渠道</th><th>金额</th><th>状态</th><th>审核</th><th>支付流水号</th><th>备注</th><th>创建时间</th></tr></thead><tbody>${rows || '<tr><td colspan="10" class="empty">暂无数据</td></tr>'}</tbody></table></div>
      ${renderPagination(`${config.rootPath}/order-payments`, params, page.total, limit, offset)}
    `, config.rootPath));
  });

  router.get("/membership-grants", async (req, res) => {
    const params = new URLSearchParams(req.query as Record<string, string>);
    const limit = parsePageSize(req.query.limit, 20);
    const offset = parseOffset(req.query.offset);
    const search = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const page = await listMembershipGrants(limit, offset, search);
    const rows = page.rows.map((row) => `
      <tr>
        <td><code>${escapeHtml(row.id)}</code></td>
        <td><a href="${config.rootPath}/membership-orders/${row.order_id}">${escapeHtml(row.order_no)}</a></td>
        <td>${renderUserCell(config.rootPath, row.user_id, row)}</td>
        <td>${renderPlanCell(row.plan_id, row.plan_name)}</td>
        <td>${renderPill(row.grant_status)}</td>
        <td>${row.subscription_is_active ? renderPill("active") : renderPill("expired")}</td>
        <td>${formatDateTime(row.starts_at)}</td>
        <td>${formatDateTime(row.expires_at)}</td>
        <td>${formatDateTime(row.created_at)}</td>
      </tr>`).join("");
    res.type("html").send(renderLayout("权益发放记录", `
      <h2>权益发放记录</h2>
      <form class="toolbar" method="get">
        <label>搜索<input name="q" value="${escapeHtml(search)}" placeholder="发放记录 / 订单号 / 订阅号 / 手机号" /></label>
        <label>每页<input name="limit" value="${limit}" /></label>
        <button type="submit">筛选</button>
      </form>
      <div class="table-wrap"><table><thead><tr><th>ID</th><th>订单号</th><th>用户</th><th>套餐</th><th>发放状态</th><th>订阅状态</th><th>开始时间</th><th>到期时间</th><th>创建时间</th></tr></thead><tbody>${rows || '<tr><td colspan="9" class="empty">暂无数据</td></tr>'}</tbody></table></div>
      ${renderPagination(`${config.rootPath}/membership-grants`, params, page.total, limit, offset)}
    `, config.rootPath));
  });

  router.get("/invite-reward-policies", async (req, res) => {
    const params = new URLSearchParams(req.query as Record<string, string>);
    const limit = parsePageSize(req.query.limit, 20);
    const offset = parseOffset(req.query.offset);
    const search = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const [policyStats, policyList, plansResult, grantPage] = await Promise.all([
      listInviteRewardPolicyStats(),
      listInviteRewardPolicies(),
      query<Plan>("SELECT * FROM plans WHERE id <> 'free' ORDER BY sort_order ASC, price_cents ASC, created_at ASC"),
      listInviteRewardGrants(limit, offset, search),
    ]);
    const flash = renderFlash(params);
    const plans = plansResult.rows;
    const planOptionsHtml = (current: string | null | undefined) => {
      const base = `<option value="">默认会员套餐（member）</option>`;
      const rest = plans.map((plan) => (
        `<option value="${escapeHtml(plan.id)}"${current === plan.id ? " selected" : ""}>${escapeHtml(plan.name)}（${escapeHtml(plan.id)} / ${escapeHtml(formatPlanDuration(plan.duration_days))}）</option>`
      )).join("");
      return `${base}${rest}`;
    };

    const policyCards = policyStats.map((row) => `
      <div class="card">
        <div class="kicker">${escapeHtml(row.id)} · ${row.is_active ? "启用中" : "已停用"}</div>
        <h2>${escapeHtml(row.name)}</h2>
        <div class="muted">${escapeHtml(row.description ?? "未填写规则说明")}</div>
        <div class="kv" style="margin-top:16px;">
          <div>规则类型</div><div>${escapeHtml(formatInviteRewardTriggerType(row.trigger_type))}</div>
          <div>触发规则</div><div>${escapeHtml(formatInviteRewardRule(row))}</div>
          <div>奖励套餐</div><div>${escapeHtml(row.reward_plan_name ?? row.reward_plan_id ?? "默认会员套餐（member）")}</div>
          <div>启用状态</div><div>${row.is_active ? renderPill("active") : renderPill("inactive")}</div>
          <div>累计发放次数</div><div>${row.grant_count}</div>
          <div>已奖励用户数</div><div>${row.rewarded_user_count}</div>
          <div>最后一次发放</div><div>${escapeHtml(formatDateTime(row.last_granted_at))}</div>
          <div>排序值</div><div>${row.sort_order}</div>
        </div>
        <h3 style="margin-top:18px;">编辑邀请奖励规则</h3>
        <form method="post" action="${config.rootPath}/invite-reward-policies/${encodeURIComponent(row.id)}">
          <label>规则名称<input name="name" value="${escapeHtml(row.name)}" required /></label>
          <label>规则说明<textarea name="description" placeholder="例如：每邀请 3 人送 7 天会员">${escapeHtml(row.description ?? "")}</textarea></label>
          <label>规则类型<select name="triggerType">${renderSelectOptions(row.trigger_type, [
            { value: "per_count", label: "每邀请满 N 人循环奖励" },
            { value: "threshold_once", label: "达到门槛一次性奖励" },
          ])}</select></label>
          <label>每次满足人数 N（仅循环奖励使用）<input name="inviteCountStep" value="${escapeHtml(String(row.invite_count_step ?? ""))}" inputmode="numeric" placeholder="例如 3" /></label>
          <label>达到人数 X（仅门槛奖励使用）<input name="thresholdCount" value="${escapeHtml(String(row.threshold_count ?? ""))}" inputmode="numeric" placeholder="例如 10" /></label>
          <label>奖励会员时长（天）<input name="rewardDurationDays" value="${row.reward_duration_days}" inputmode="numeric" required /></label>
          <label>奖励套餐<select name="rewardPlanId">${planOptionsHtml(row.reward_plan_id)}</select></label>
          <label>最多奖励次数（留空表示不限制，仅循环奖励使用）<input name="maxRewardTimes" value="${escapeHtml(String(row.max_reward_times ?? ""))}" inputmode="numeric" placeholder="例如 5" /></label>
          <label>排序值（越小越靠前）<input name="sortOrder" value="${row.sort_order}" inputmode="numeric" required /></label>
          <label><input type="checkbox" name="isActive" ${row.is_active ? "checked" : ""} /> 启用这条邀请奖励规则</label>
          <div class="actions">
            <button type="submit">保存规则</button>
          </div>
        </form>
      </div>
    `).join("");

    const grantRows = grantPage.rows.map((row) => `
      <tr>
        <td><code>${escapeHtml(row.id)}</code></td>
        <td>${renderUserCell(config.rootPath, row.user_id, row)}</td>
        <td>${escapeHtml(row.policy_name ?? "-")}</td>
        <td>${escapeHtml(formatInviteRewardGrantTrigger(row))}</td>
        <td>${escapeHtml(formatPlanDuration(row.reward_duration_days))}</td>
        <td>${escapeHtml(row.reward_plan_name ?? row.reward_plan_id ?? "默认会员套餐（member）")}</td>
        <td>${renderPill(row.status)}</td>
        <td>${formatDateTime(row.subscription_expires_at)}</td>
        <td>${escapeHtml(row.note ?? "-")}</td>
        <td>${formatDateTime(row.granted_at)}</td>
      </tr>
    `).join("");

    res.type("html").send(renderLayout("邀请奖励配置", `
      <h2>邀请奖励规则</h2>
      ${flash}
      <div class="card" style="margin-bottom:16px;">
        <h3>规则说明</h3>
        <ul class="compact">
          <li>支持两种规则：<strong>每邀请满 N 人送 M 天</strong>、<strong>达到 X 人一次性送 Y 天</strong>。</li>
          <li>同一邀请节点只会发放一次，系统通过“邀请人数触发点 + 规则 ID”自动去重。</li>
          <li>邀请奖励会直接顺延用户当前有效会员时长；若当前没有有效会员，则自动开通奖励套餐。</li>
          <li>奖励套餐可留空，留空时使用默认会员套餐 <code>member</code>。</li>
        </ul>
      </div>

      <div class="card" style="margin-bottom:16px;">
        <div class="section-title"><h3>新增邀请奖励规则</h3><span class="muted">当前共 ${policyList.length} 条规则</span></div>
        <form method="post" action="${config.rootPath}/invite-reward-policies">
          <div class="toolbar">
            <label>规则名称<input name="name" placeholder="例如：每邀 3 人送 7 天" required /></label>
            <label>规则类型<select name="triggerType">${renderSelectOptions("per_count", [
              { value: "per_count", label: "每邀请满 N 人循环奖励" },
              { value: "threshold_once", label: "达到门槛一次性奖励" },
            ])}</select></label>
            <label>每次满足人数 N<input name="inviteCountStep" inputmode="numeric" placeholder="例如 3" /></label>
            <label>达到人数 X<input name="thresholdCount" inputmode="numeric" placeholder="例如 10" /></label>
            <label>奖励会员时长（天）<input name="rewardDurationDays" inputmode="numeric" placeholder="例如 7" required /></label>
            <label>奖励套餐<select name="rewardPlanId">${planOptionsHtml(null)}</select></label>
            <label>最多奖励次数<input name="maxRewardTimes" inputmode="numeric" placeholder="留空=不限制" /></label>
            <label>排序值<input name="sortOrder" inputmode="numeric" value="0" required /></label>
            <label><input type="checkbox" name="isActive" checked /> 立即启用</label>
          </div>
          <label>规则说明<textarea name="description" placeholder="例如：邀请越多送越多，自动顺延会员到期时间"></textarea></label>
          <div class="actions">
            <button type="submit">新增规则</button>
          </div>
        </form>
      </div>

      <div class="grid">${policyCards || '<div class="card empty">暂无邀请奖励规则，请先创建</div>'}</div>

      <div class="card" style="margin-top:16px;">
        <div class="section-title"><h3>邀请奖励发放记录</h3><span class="muted">查看自动发奖情况</span></div>
        <form class="toolbar" method="get">
          <label>搜索<input name="q" value="${escapeHtml(search)}" placeholder="用户 / 规则 / 备注 / grant id" /></label>
          <label>每页<input name="limit" value="${limit}" /></label>
          <button type="submit">筛选</button>
        </form>
        <div class="table-wrap"><table><thead><tr><th>ID</th><th>用户</th><th>规则</th><th>触发条件</th><th>奖励时长</th><th>奖励套餐</th><th>状态</th><th>当前到期</th><th>备注</th><th>发放时间</th></tr></thead><tbody>${grantRows || '<tr><td colspan="10" class="empty">暂无邀请奖励发放记录</td></tr>'}</tbody></table></div>
        ${renderPagination(`${config.rootPath}/invite-reward-policies`, params, grantPage.total, limit, offset)}
      </div>
    `, config.rootPath));
  });

  router.post("/invite-reward-policies", async (req, res) => {
    const target = `${config.rootPath}/invite-reward-policies`;
    try {
      const name = String(req.body.name || "").trim();
      if (!name) {
        redirectWithMessage(res, target, "error", "规则名称不能为空");
        return;
      }

      const triggerType = String(req.body.triggerType || "").trim() as InviteRewardTriggerType;
      if (triggerType !== "per_count" && triggerType !== "threshold_once") {
        redirectWithMessage(res, target, "error", "规则类型不合法");
        return;
      }

      const rewardDurationDays = parsePositiveInt(req.body.rewardDurationDays);
      if (rewardDurationDays === null) {
        redirectWithMessage(res, target, "error", "奖励会员时长必须是正整数");
        return;
      }

      const inviteCountStep = parseOptionalPositiveInt(req.body.inviteCountStep);
      const thresholdCount = parseOptionalPositiveInt(req.body.thresholdCount);
      if (triggerType === "per_count" && inviteCountStep === null) {
        redirectWithMessage(res, target, "error", "循环奖励规则必须填写“每次满足人数 N”");
        return;
      }
      if (triggerType === "threshold_once" && thresholdCount === null) {
        redirectWithMessage(res, target, "error", "门槛奖励规则必须填写“达到人数 X”");
        return;
      }

      const rewardPlanId = String(req.body.rewardPlanId || "").trim() || null;
      if (rewardPlanId) {
        const rewardPlan = await getPlanById(rewardPlanId);
        if (!rewardPlan || rewardPlan.id === "free") {
          redirectWithMessage(res, target, "error", "奖励套餐不存在");
          return;
        }
      }

      const sortOrder = parseIntegerAtLeast(req.body.sortOrder, 0);
      if (sortOrder === null) {
        redirectWithMessage(res, target, "error", "排序值必须是大于等于 0 的整数");
        return;
      }

      const created = await createInviteRewardPolicy({
        name,
        description: String(req.body.description || "").trim() || null,
        triggerType,
        inviteCountStep: triggerType === "per_count" ? inviteCountStep : null,
        thresholdCount: triggerType === "threshold_once" ? thresholdCount : null,
        rewardDurationDays,
        rewardPlanId,
        maxRewardTimes: triggerType === "per_count" ? parseOptionalPositiveInt(req.body.maxRewardTimes) : null,
        sortOrder,
        isActive: parseCheckbox(req.body.isActive),
      });

      redirectWithMessage(res, target, "ok", `邀请奖励规则「${created.name}」已创建`);
    } catch (error) {
      redirectWithMessage(res, target, "error", error instanceof Error ? error.message : String(error));
    }
  });

  router.post("/invite-reward-policies/:id", async (req, res) => {
    const target = `${config.rootPath}/invite-reward-policies`;
    try {
      const existing = await getInviteRewardPolicyById(req.params.id);
      if (!existing) {
        redirectWithMessage(res, target, "error", "邀请奖励规则不存在");
        return;
      }

      const name = String(req.body.name || "").trim();
      if (!name) {
        redirectWithMessage(res, target, "error", "规则名称不能为空");
        return;
      }

      const triggerType = String(req.body.triggerType || "").trim() as InviteRewardTriggerType;
      if (triggerType !== "per_count" && triggerType !== "threshold_once") {
        redirectWithMessage(res, target, "error", "规则类型不合法");
        return;
      }

      const rewardDurationDays = parsePositiveInt(req.body.rewardDurationDays);
      if (rewardDurationDays === null) {
        redirectWithMessage(res, target, "error", "奖励会员时长必须是正整数");
        return;
      }

      const inviteCountStep = parseOptionalPositiveInt(req.body.inviteCountStep);
      const thresholdCount = parseOptionalPositiveInt(req.body.thresholdCount);
      if (triggerType === "per_count" && inviteCountStep === null) {
        redirectWithMessage(res, target, "error", "循环奖励规则必须填写“每次满足人数 N”");
        return;
      }
      if (triggerType === "threshold_once" && thresholdCount === null) {
        redirectWithMessage(res, target, "error", "门槛奖励规则必须填写“达到人数 X”");
        return;
      }

      const rewardPlanId = String(req.body.rewardPlanId || "").trim() || null;
      if (rewardPlanId) {
        const rewardPlan = await getPlanById(rewardPlanId);
        if (!rewardPlan || rewardPlan.id === "free") {
          redirectWithMessage(res, target, "error", "奖励套餐不存在");
          return;
        }
      }

      const sortOrder = parseIntegerAtLeast(req.body.sortOrder, 0);
      if (sortOrder === null) {
        redirectWithMessage(res, target, "error", "排序值必须是大于等于 0 的整数");
        return;
      }

      const updated = await updateInviteRewardPolicy(existing.id, {
        name,
        description: String(req.body.description || "").trim() || null,
        triggerType,
        inviteCountStep: triggerType === "per_count" ? inviteCountStep : null,
        thresholdCount: triggerType === "threshold_once" ? thresholdCount : null,
        rewardDurationDays,
        rewardPlanId,
        maxRewardTimes: triggerType === "per_count" ? parseOptionalPositiveInt(req.body.maxRewardTimes) : null,
        sortOrder,
        isActive: parseCheckbox(req.body.isActive),
      });

      if (!updated) {
        redirectWithMessage(res, target, "error", "邀请奖励规则更新失败");
        return;
      }

      redirectWithMessage(res, target, "ok", `邀请奖励规则「${updated.name}」已更新`);
    } catch (error) {
      redirectWithMessage(res, target, "error", error instanceof Error ? error.message : String(error));
    }
  });

  router.get("/auth-sessions", async (req, res) => {
    const params = new URLSearchParams(req.query as Record<string, string>);
    const limit = parsePageSize(req.query.limit, 20);
    const offset = parseOffset(req.query.offset);
    const search = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const status = typeof req.query.status === "string" ? req.query.status.trim() : "";
    const page = await listAuthSessions(limit, offset, search, status);
    const returnTo = `${config.rootPath}/auth-sessions${params.toString() ? `?${params.toString()}` : ""}`;
    const rows = page.rows.map((row) => {
      const state = getAuthSessionState(row);
      return `
        <tr>
          <td><code>${escapeHtml(row.id)}</code></td>
          <td>${renderUserCell(config.rootPath, row.user_id, row)}</td>
          <td>${escapeHtml(row.device_name ?? row.device_id ?? row.platform ?? "-")}${row.user_agent ? `<div class="muted">${escapeHtml(truncate(row.user_agent, 72))}</div>` : ""}</td>
          <td>${renderPlanCell(row.active_plan_id ?? "-", row.active_plan_name)}</td>
          <td>${escapeHtml(row.last_ip ?? "-")}</td>
          <td>${formatDateTime(row.last_seen_at)}</td>
          <td>${formatDateTime(row.refresh_expires_at)}</td>
          <td>${renderPill(state)}</td>
          <td>${formatDateTime(row.revoked_at)}</td>
          <td>
            ${state === "active"
              ? `<form class="inline-form" method="post" action="${config.rootPath}/auth-sessions/${row.id}/revoke"><input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}" /><button type="submit" class="secondary">撤销</button></form>`
              : '<span class="muted">-</span>'}
          </td>
        </tr>`;
    }).join("");
    res.type("html").send(renderLayout("设备会话", `
      <h2>设备会话</h2>
      ${renderFlash(params)}
      <form class="toolbar" method="get">
        <label>搜索<input name="q" value="${escapeHtml(search)}" placeholder="用户 / 设备 / IP / 会话 ID" /></label>
        <label>状态<select name="status"><option value="">全部状态</option>${renderSelectOptions(status, [
          { value: "active", label: "有效" },
          { value: "expired", label: "已过期" },
          { value: "revoked", label: "已撤销" },
        ])}</select></label>
        <label>每页<input name="limit" value="${limit}" /></label>
        <button type="submit">筛选</button>
      </form>
      <div class="table-wrap"><table><thead><tr><th>会话 ID</th><th>用户</th><th>设备</th><th>套餐</th><th>IP</th><th>最后活跃</th><th>刷新令牌到期</th><th>状态</th><th>撤销时间</th><th>操作</th></tr></thead><tbody>${rows || '<tr><td colspan="10" class="empty">暂无会话记录</td></tr>'}</tbody></table></div>
      ${renderPagination(`${config.rootPath}/auth-sessions`, params, page.total, limit, offset)}
    `, config.rootPath));
  });

  router.post("/auth-sessions/:id/revoke", async (req, res) => {
    const target = normalizeReturnTo(config, req.body.returnTo, `${config.rootPath}/auth-sessions`);
    try {
      const revoked = await revokeAuthDeviceSessionById(req.params.id);
      if (!revoked) {
        redirectWithMessage(res, target, "error", "会话不存在或已失效");
        return;
      }
      redirectWithMessage(res, target, "ok", "设备会话已撤销");
    } catch (error) {
      redirectWithMessage(res, target, "error", error instanceof Error ? error.message : String(error));
    }
  });

  return router;
}
