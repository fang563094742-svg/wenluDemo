/**
 * LLM 提供方池（LlmPool）· 大脑去单点 + 本地兜底
 * ------------------------------------------------------------------
 * 第一性原理：呼吸 = 大脑驱动。若大脑只接一个端点（现状 code.oai1.online 单中转），
 * 该端点挂了/限速了/跑路了 → 问路直接变植物人。这是致命单点。
 *
 * 解法：把"一个 provider"升级成"按优先级排布的 provider 池"，逐个故障转移：
 *   中转A（强模型，质量优先） → 中转B（备用中转） → 本地模型（Ollama，断网保命） → 用尽抛错
 *
 * 与 ResilientLlm 的分工（两层韧性，不重复）：
 *   - ResilientLlm：包住【单个】provider，做"同一端点"的重试+超时+退避（抖动级韧性）。
 *   - LlmPool：跨【多个】provider 故障转移（端点级韧性）。池里每个成员通常已是 ResilientLlm。
 *
 * 健康记忆：每个成员维护连续失败计数，连续失败超阈值则"熔断降级"（暂时跳过，定期半开重试），
 * 避免每次都在已死的端点上浪费整轮重试时间。成功立即复位。
 *
 * 沿用弟弟 ESM 约定：相对导入带 `.js` 扩展。
 */

import type { LLM_Provider, LlmRequest, LlmResponse, LlmToolRequest, LlmToolResponse } from "./llmProvider.js";

/** 所有 provider 都失败时抛出——调用方据此挂起任务，而非崩溃。 */
export class LlmPoolExhaustedError extends Error {
  readonly tried: string[];
  constructor(message: string, tried: string[]) {
    super(message);
    this.name = "LlmPoolExhaustedError";
    this.tried = tried;
  }
}

/** 池成员：一个 provider + 它在池中的角色标签。 */
export interface LlmPoolMember {
  /** 底层 provider（通常是 ResilientLlm 包装后的）。 */
  provider: LLM_Provider;
  /** 角色标签：用于日志/诊断/路由，如 "relay-primary" / "relay-backup" / "local"。 */
  role: string;
  /** 是否本地模型（断网兜底层）。本地成员永不被熔断跳过（它是最后防线）。 */
  isLocal?: boolean;
}

export interface LlmPoolOptions {
  /** 连续失败多少次后熔断该成员（暂时跳过），默认 3。 */
  breakerThreshold?: number;
  /** 熔断后多久进入半开（允许再试一次），默认 60s。 */
  breakerCooldownMs?: number;
  /** 事件钩子（诊断/留痕）。 */
  onEvent?: (ev: { kind: "failover" | "exhausted" | "recovered" | "breaker-open"; role: string; detail?: string }) => void;
}

interface MemberState {
  consecutiveFailures: number;
  openedAt: number | null; // 熔断打开时间戳；null=闭合
}

const DEFAULTS = {
  breakerThreshold: 3,
  breakerCooldownMs: 60_000,
};

/**
 * LLM 池：按成员顺序故障转移，带熔断降级。对外仍是一个标准 LLM_Provider。
 * providerKey 取首个成员（主力）的 key，保持对既有调用方透明。
 */
export class LlmPool implements LLM_Provider {
  readonly providerKey: string;
  private readonly members: LlmPoolMember[];
  private readonly states: MemberState[];
  private readonly opts: typeof DEFAULTS;
  private readonly onEvent?: LlmPoolOptions["onEvent"];

  constructor(members: LlmPoolMember[], options: LlmPoolOptions = {}) {
    if (members.length === 0) throw new Error("LlmPool 至少需要一个成员");
    this.members = members;
    this.states = members.map(() => ({ consecutiveFailures: 0, openedAt: null }));
    this.providerKey = members[0].provider.providerKey;
    this.opts = {
      breakerThreshold: options.breakerThreshold ?? DEFAULTS.breakerThreshold,
      breakerCooldownMs: options.breakerCooldownMs ?? DEFAULTS.breakerCooldownMs,
    };
    this.onEvent = options.onEvent;
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    return this.run("complete", (p) => p.complete(req));
  }

  async completeWithTools(req: LlmToolRequest): Promise<LlmToolResponse> {
    return this.run("completeWithTools", (p) => p.completeWithTools(req));
  }

  /** 当前可用成员索引（跳过熔断中的非本地成员；本地成员永远参与）。 */
  private isAvailable(idx: number, now: number): boolean {
    const st = this.states[idx];
    const member = this.members[idx];
    if (member.isLocal) return true; // 本地兜底永不跳过
    if (st.openedAt === null) return true;
    // 熔断冷却到期 → 半开，允许试一次。
    if (now - st.openedAt >= this.opts.breakerCooldownMs) return true;
    return false;
  }

  private recordSuccess(idx: number): void {
    const st = this.states[idx];
    if (st.consecutiveFailures > 0 || st.openedAt !== null) {
      this.onEvent?.({ kind: "recovered", role: this.members[idx].role });
    }
    st.consecutiveFailures = 0;
    st.openedAt = null;
  }

  private recordFailure(idx: number): void {
    const st = this.states[idx];
    st.consecutiveFailures += 1;
    if (st.consecutiveFailures >= this.opts.breakerThreshold && st.openedAt === null) {
      st.openedAt = Date.now();
      this.onEvent?.({ kind: "breaker-open", role: this.members[idx].role, detail: `连续失败${st.consecutiveFailures}次，熔断` });
    }
  }

  /** 故障转移执行：按序尝试每个可用成员，首个成功即返回。 */
  private async run<T>(label: string, fn: (p: LLM_Provider) => Promise<T>): Promise<T> {
    const now = Date.now();
    const tried: string[] = [];
    let lastErr: unknown;

    for (let i = 0; i < this.members.length; i++) {
      if (!this.isAvailable(i, now)) continue;
      const member = this.members[i];
      tried.push(member.role);
      try {
        const result = await fn(member.provider);
        this.recordSuccess(i);
        return result;
      } catch (e) {
        lastErr = e;
        this.recordFailure(i);
        const detail = e instanceof Error ? e.message.slice(0, 160) : String(e);
        // 还有下一个可用成员才算 failover；否则下面会抛 exhausted。
        if (i < this.members.length - 1) {
          this.onEvent?.({ kind: "failover", role: member.role, detail: `${label} 失败，转下一出口：${detail}` });
        }
      }
    }

    this.onEvent?.({ kind: "exhausted", role: tried.join("→"), detail: lastErr instanceof Error ? lastErr.message.slice(0, 160) : String(lastErr) });
    throw new LlmPoolExhaustedError(
      `LLM 池全部成员失败（尝试：${tried.join(" → ") || "无可用成员"}）：${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
      tried,
    );
  }
}
