/**
 * 技能反哺（Skill Reflux）· Verifier（验证，verifier.ts）
 * ------------------------------------------------------------------
 * 定位：`skill-flywheel` 一期单一 `verified` 布尔（体现于 `SkillSpec.provenance.verifiedCount`）
 * 的二期云反哺扩展（Req 7/8/15.8）。
 *
 * **复用一期/既有内核，不重写**：
 *  - 客观裁定与证据收集统一复用 `src/verification`（`verificationEngine` / `evidenceCollector`），
 *    不另造验证执行器；shell 断言落到「服务端」或「真实连接器」由注入的 `HostShellExec` 决定。
 *  - 危险命令预审复用 `src/capability-pool/repo.ts` 的等价黑名单（该模块未导出，这里内联一份
 *    等价 `DANGEROUS_PATTERNS`，与之保持同步语义）。
 *
 * 在一期之上**扩展**两级细化验证状态（Req 7.5 向上兼容）：
 *  - `server-verified`：服务端 `sh` 跑通的弱证据，不代表任何用户平台可用（Req 8.1）。
 *  - `connector-verified`：在该平台真实连接器上跑通并收证，是判定平台可用性的唯一依据
 *    （Req 8.2/8.3/15.8）。**凡 `connector-verified` 即满足一期 `verified`**，回填
 *    `provenance.verifiedCount`（Req 7.5）。
 *
 * 降级（Req 8.6）：已 `connector-verified` 的变体在该平台执行失败 → `fail_streak++` 并降
 * `success_rate`；`fail_streak ≥ config.Connector_Downgrade_Streak` → `verify_status` 降为
 * `unverified`。
 *
 * 软性类（Req 7.3）：LLM 评审打分，**不执行任何命令**。
 *
 * 依赖注入：连接器（`ConnectorLike`）/ 验证引擎（`VerificationEngine`）/ 软技能评审器
 * （`SoftSkillReviewer`）/ 数据访问（`VerifierStore`）全部可注入，便于 mock（单测脱离真实
 * PG / 真实连接器 / 真实 LLM）。
 *
 * _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 8.1, 8.2, 8.3, 8.4, 8.6, 15.8_
 */

import {
  createVerificationEngine,
  createEvidenceCollector,
  shellAssertion,
  type VerificationEngine,
  type EvidenceCollector,
  type VerificationResult,
} from "../verification/index.js";
import type { HostShellExec } from "../verification/verificationEngine.js";
import { DEFAULT_REFLUX_CONFIG, type RefluxConfig } from "./config.js";
import type { VariantOS, VerifyStatus } from "./types.js";

// ─────────────────────────────────────────────────────────────────
// 危险命令黑名单（与 capability-pool/repo.ts 等价；该模块未导出故内联一份）
// ─────────────────────────────────────────────────────────────────

/**
 * 安全预审黑名单（Req 7.1）。与 `src/capability-pool/repo.ts` 的 `DANGEROUS_PATTERNS`
 * 语义一致：命中任一模式即判定命令不安全、拒绝验证（不下发服务端、更不下发连接器）。
 */
const DANGEROUS_PATTERNS: RegExp[] = [
  /\brm\s+(-rf?|--recursive)\s+[\/~]/i, // rm -rf /
  /\bsudo\b/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /\b(curl|wget)\s+.*\|\s*(bash|sh|zsh)/i, // curl | bash
  /\bchmod\s+777/i,
  />\s*\/dev\/sd/i,
  /\bformat\b.*\b[a-z]:/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /DROP\s+(TABLE|DATABASE)/i,
  /TRUNCATE/i,
  /\beval\s*\(/i,
  /\bnc\s+.*-e/i, // netcat reverse shell
];

/** 检查命令是否安全（白名单思路：不含危险模式=安全）。 */
function isCommandSafe(command: string): { safe: boolean; reason: string } {
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      return { safe: false, reason: `命令匹配危险模式: ${pattern.source}` };
    }
  }
  return { safe: true, reason: "未匹配任何危险命令模式" };
}

// ─────────────────────────────────────────────────────────────────
// 连接器抽象（依赖注入；ConnectorBridge 结构上即满足）
// ─────────────────────────────────────────────────────────────────

/** 连接器 exec 的返回形状（与 riverMain 既有约定一致）。 */
export interface ConnectorExecResult {
  ok: boolean;
  stdout?: string;
  stderr?: string;
  code?: number;
}

/**
 * Verifier 所需的连接器最小契约（`ConnectorBridge` 结构上即满足，可直接注入）。
 * 仅用到 exec 下发、在线判定与当前连接器平台信息（用于回填 `verified_by`）。
 */
export interface ConnectorLike {
  request<T = unknown>(op: "exec", args: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  isOnline?(): boolean;
  activeInfo?(): { platform: string; arch?: string; machineLabel?: string } | null;
}

/**
 * 把连接器封装为 `verificationEngine` 可用的 `HostShellExec`（迁移点：shell 断言落到
 * 真实连接器执行，证据来自用户本机）。返回 null 仅在连接器不可用时，由引擎回退服务端。
 */
function connectorShellExec(connector: ConnectorLike): HostShellExec {
  return async (cmd, cwd, timeoutMs) => {
    const args: Record<string, unknown> = { command: cmd };
    if (cwd) args.cwd = cwd;
    const r = await connector.request<ConnectorExecResult>("exec", args, timeoutMs + 5_000);
    if (!r) return null;
    return {
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
      code: typeof r.code === "number" ? r.code : r.ok ? 0 : 1,
    };
  };
}

// ─────────────────────────────────────────────────────────────────
// 软技能评审器（依赖注入，便于 mock；不执行命令）
// ─────────────────────────────────────────────────────────────────

/** 软技能评审输入（Req 7.3：仅文本，不含可执行体）。 */
export interface SoftSkillReviewInput {
  title: string;
  description: string;
  applicable_scenario?: string;
  /** 候选草稿（供评审器参考，可选）。 */
  draft?: Record<string, unknown>;
}

/** 软技能评审结果。`pass` 缺省时由 `config.High_Score` 阈值推导。 */
export interface SoftReviewResult {
  /** 评分（约定区间 [0,1]）。 */
  score: number;
  /** 是否通过评审。 */
  pass: boolean;
  /** 评审理由（可选）。 */
  reason?: string;
}

/** 软技能评审器接口（依赖注入点；生产注入包裹 `src/llm` 的实现，单测注入 mock）。 */
export interface SoftSkillReviewer {
  review(input: SoftSkillReviewInput): Promise<{ score: number; pass?: boolean; reason?: string }>;
}

// ─────────────────────────────────────────────────────────────────
// 可执行验证输入/输出
// ─────────────────────────────────────────────────────────────────

/** 可执行技能验证入参。 */
export interface VerifyExecutableInput {
  /** 已物化技能 id（提供则回写 `skill_platform_variant`/`skill`；不提供则只做裁定不落库）。 */
  skillId?: string;
  /** 待验证命令（值/结构分离后的具体平台命令）。 */
  command: string;
  /** 目标平台（mac/win/linux）。 */
  os: VariantOS;
  /** 可选的验证断言命令（hard-gate）；不提供则以 command 自身退出码为准。 */
  verifyCmd?: string;
  /** true → 经真实连接器在目标平台跑通记 connector-verified；false → 仅服务端预检记 server-verified。 */
  viaConnector: boolean;
  /** 可选指定验证来源连接器标识（不提供则取 connector.activeInfo()）。 */
  connectorId?: string;
  /** 单步超时（毫秒），默认 10s。 */
  timeoutMs?: number;
}

/** 可执行验证结果。 */
export interface VerifyResult {
  /** 落定的验证状态（unverified / server-verified / connector-verified）。 */
  status: VerifyStatus;
  /** 客观裁定是否通过（hard-gate 全过）。 */
  passed: boolean;
  /** 目标平台。 */
  os: VariantOS;
  /** 验证来源连接器标识（仅 connector-verified）。 */
  verifiedBy?: string;
  /** 结构化验证证据（来自 verificationEngine；安全拦截时为 undefined）。 */
  evidence?: VerificationResult;
  /** 是否被安全预审拦截。 */
  safetyBlocked: boolean;
  /** 人类可读结论/原因。 */
  reason: string;
}

// ─────────────────────────────────────────────────────────────────
// 数据访问抽象（依赖注入，便于单测脱离真实 PG）
// ─────────────────────────────────────────────────────────────────

/** 降级结果。 */
export interface DowngradeResult {
  /** 累计连续失败次数。 */
  failStreak: number;
  /** 是否已降为 unverified。 */
  downgraded: boolean;
}

/**
 * Verifier 所需的数据访问抽象。默认实现走真实 PG（`createPgVerifierStore`）；单测注入内存桩。
 * SQL 细节封装在 store 内，核心裁定/标记逻辑保持可纯测。
 */
export interface VerifierStore {
  /**
   * 记 server-verified（弱证据，Req 8.1）。**不回填** `provenance.verifiedCount`
   * （服务端跑通不代表平台可用，不满足一期 verified）；不覆盖已 connector-verified 的变体。
   */
  markServerVerified(skillId: string, os: VariantOS): Promise<void>;
  /**
   * 记该平台 connector-verified（Req 8.3/15.8），清零 fail_streak，并**回填**
   * `provenance.verifiedCount`（向上兼容一期 verified，Req 7.5）。
   */
  markConnectorVerified(skillId: string, os: VariantOS, verifiedBy: string): Promise<void>;
  /**
   * 降级（Req 8.6）：fail_streak++ 并降 success_rate；当 fail_streak ≥ downgradeStreak 时
   * 把 verify_status 降为 unverified。返回最新 fail_streak 与是否降级。
   */
  recordVariantFailure(
    skillId: string,
    os: VariantOS,
    downgradeStreak: number,
  ): Promise<DowngradeResult>;
}

// ─────────────────────────────────────────────────────────────────
// Verifier 依赖与接口
// ─────────────────────────────────────────────────────────────────

/** Verifier 依赖（全部可选，默认走真实 verification + PG + 默认配置）。 */
export interface VerifierDeps {
  /** 服务端验证引擎；默认 `createVerificationEngine()`（服务端 exec）。 */
  serverEngine?: VerificationEngine;
  /**
   * 连接器验证引擎工厂；默认基于注入的连接器构造 `createVerificationEngine({ shellExec })`，
   * 使 shell 断言落到真实连接器执行。单测可注入返回 mock 引擎的工厂。
   */
  connectorEngineFactory?: (connector: ConnectorLike) => VerificationEngine;
  /** 真实连接器（connector-verified 路径必需；ConnectorBridge 结构上即满足）。 */
  connector?: ConnectorLike;
  /** 证据收集器；默认 `createEvidenceCollector()`。 */
  evidence?: EvidenceCollector;
  /** 软技能评审器（reviewSoft 必需）。 */
  softReviewer?: SoftSkillReviewer;
  /** 数据访问层；默认 `createPgVerifierStore()`（真实 PG）。 */
  store?: VerifierStore;
  /** 反哺配置（取 Connector_Downgrade_Streak / High_Score）；默认 DEFAULT_REFLUX_CONFIG。 */
  config?: RefluxConfig;
}

/** Verifier 对外接口（对齐 design.md「Components and Interfaces · Verifier」）。 */
export interface Verifier {
  /** 可执行类验证：安全预审 → 服务端 server-verified / 连接器 connector-verified。 */
  verifyExecutable(input: VerifyExecutableInput): Promise<VerifyResult>;
  /** 软性类验证：LLM 评审打分，不执行命令（Req 7.3）。 */
  reviewSoft(input: SoftSkillReviewInput): Promise<SoftReviewResult>;
  /** 降级：connector-verified 变体在该平台执行失败时调用（Req 8.6）。 */
  downgradeOnFailure(skillId: string, os: VariantOS): Promise<DowngradeResult>;
}

// ─────────────────────────────────────────────────────────────────
// Verifier 工厂
// ─────────────────────────────────────────────────────────────────

/**
 * 创建 Verifier 实例。
 * @param deps 可选依赖；不传则走真实 verification + PG + 默认配置（reviewSoft 仍需注入评审器）。
 */
export function createVerifier(deps: VerifierDeps = {}): Verifier {
  const config = deps.config ?? DEFAULT_REFLUX_CONFIG;
  const serverEngine = deps.serverEngine ?? createVerificationEngine();
  const evidence = deps.evidence ?? createEvidenceCollector();
  const store = deps.store ?? createPgVerifierStore();
  const connectorEngineFactory =
    deps.connectorEngineFactory ??
    ((connector: ConnectorLike) => createVerificationEngine({ shellExec: connectorShellExec(connector) }));

  /** 构造一条 hard-gate shell 断言（验证命令优先，否则用待验证命令自身退出码）。 */
  function buildAssertion(input: VerifyExecutableInput) {
    const cmd = input.verifyCmd && input.verifyCmd.trim() ? input.verifyCmd : input.command;
    return shellAssertion({
      description: `verify executable on ${input.os}`,
      cmd,
      expect: "exit-zero",
      severity: "hard-gate",
      timeoutMs: input.timeoutMs ?? 10_000,
    });
  }

  return {
    async verifyExecutable(input: VerifyExecutableInput): Promise<VerifyResult> {
      const os = input.os;

      // 1) 安全预审（Req 7.1）：命令或验证命令命中危险模式即拦截，不下发任何执行环境。
      const safe = isCommandSafe(input.command);
      const safeVerify = input.verifyCmd ? isCommandSafe(input.verifyCmd) : { safe: true, reason: "" };
      if (!safe.safe || !safeVerify.safe) {
        return {
          status: "unverified",
          passed: false,
          os,
          safetyBlocked: true,
          reason: !safe.safe ? safe.reason : safeVerify.reason,
        };
      }

      const taskId = `verify:${input.skillId ?? "adhoc"}:${os}`;
      const assertion = buildAssertion(input);
      const context = { taskId, stateSnapshot: null, workingDir: process.cwd() };

      // 2) connector-verified 路径（Req 8.3/15.8）：经真实连接器在目标平台跑通并收证。
      if (input.viaConnector) {
        const connector = deps.connector;
        if (!connector) {
          return {
            status: "unverified",
            passed: false,
            os,
            safetyBlocked: false,
            reason: "无连接器在线：无法进行 connector-verified 验证",
          };
        }
        const engine = connectorEngineFactory(connector);
        let result: VerificationResult;
        try {
          result = await engine.verify(taskId, [assertion], context);
        } catch (err) {
          return {
            status: "unverified",
            passed: false,
            os,
            safetyBlocked: false,
            reason: `连接器验证执行异常: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
        evidence.store(result);
        const passed = result.overallVerdict === "passed" && result.hardGatesPassed;
        if (!passed) {
          return {
            status: "unverified",
            passed: false,
            os,
            evidence: result,
            safetyBlocked: false,
            reason: `连接器验证未通过: ${result.summary}`,
          };
        }
        const verifiedBy =
          input.connectorId ??
          (() => {
            const info = connector.activeInfo?.();
            return info?.machineLabel ?? info?.platform ?? "connector";
          })();
        // 凡 connector-verified 即满足一期 verified，回填 provenance.verifiedCount（Req 7.5）。
        if (input.skillId) {
          await store.markConnectorVerified(input.skillId, os, verifiedBy);
        }
        return {
          status: "connector-verified",
          passed: true,
          os,
          verifiedBy,
          evidence: result,
          safetyBlocked: false,
          reason: `connector-verified on ${os} by ${verifiedBy}`,
        };
      }

      // 3) server-verified 路径（弱证据，Req 8.1）：服务端 sh 跑通仅记 server-verified。
      let result: VerificationResult;
      try {
        result = await serverEngine.verify(taskId, [assertion], context);
      } catch (err) {
        return {
          status: "unverified",
          passed: false,
          os,
          safetyBlocked: false,
          reason: `服务端验证执行异常: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      evidence.store(result);
      const passed = result.overallVerdict === "passed" && result.hardGatesPassed;
      if (!passed) {
        return {
          status: "unverified",
          passed: false,
          os,
          evidence: result,
          safetyBlocked: false,
          reason: `服务端验证未通过: ${result.summary}`,
        };
      }
      if (input.skillId) {
        await store.markServerVerified(input.skillId, os);
      }
      return {
        status: "server-verified",
        passed: true,
        os,
        evidence: result,
        safetyBlocked: false,
        reason: `server-verified（弱证据，不代表 ${os} 平台可用）: ${result.summary}`,
      };
    },

    async reviewSoft(input: SoftSkillReviewInput): Promise<SoftReviewResult> {
      const reviewer = deps.softReviewer;
      if (!reviewer) {
        throw new Error("reviewSoft 需要注入 softReviewer（LLM 评审器）");
      }
      const r = await reviewer.review(input);
      const score = Number.isFinite(r.score) ? r.score : 0;
      // pass 缺省时由 High_Score 阈值推导（Req 7.3：软性类无客观验证，靠评审分门控）。
      const pass = typeof r.pass === "boolean" ? r.pass : score >= config.High_Score;
      return { score, pass, reason: r.reason };
    },

    async downgradeOnFailure(skillId: string, os: VariantOS): Promise<DowngradeResult> {
      return store.recordVariantFailure(skillId, os, config.Connector_Downgrade_Streak);
    },
  };
}

// ─────────────────────────────────────────────────────────────────
// 默认 PG 数据访问实现
// ─────────────────────────────────────────────────────────────────

/**
 * 创建走真实 PG 的 VerifierStore。变体表/技能表（006 迁移新增、无 RLS）走系统级 `query`。
 */
export function createPgVerifierStore(): VerifierStore {
  return {
    async markServerVerified(skillId: string, os: VariantOS): Promise<void> {
      const { query } = await import("../db/pool.js");
      // 不覆盖已 connector-verified 的变体（弱证据不得降级强证据）。
      await query(
        `UPDATE skill_platform_variant
            SET verify_status = 'server-verified', verified_at = now()
          WHERE skill_id = $1 AND os = $2 AND verify_status <> 'connector-verified'`,
        [skillId, os],
      );
    },

    async markConnectorVerified(skillId: string, os: VariantOS, verifiedBy: string): Promise<void> {
      const { query } = await import("../db/pool.js");
      await query(
        `UPDATE skill_platform_variant
            SET verify_status = 'connector-verified', verified_at = now(),
                verified_by = $3, fail_streak = 0
          WHERE skill_id = $1 AND os = $2`,
        [skillId, os, verifiedBy],
      );
      // 回填 provenance.verifiedCount（向上兼容一期 verified，Req 7.5）。
      await query(
        `UPDATE skill
            SET provenance = jsonb_set(
                  COALESCE(provenance, '{}'::jsonb),
                  '{verifiedCount}',
                  to_jsonb(COALESCE((provenance->>'verifiedCount')::int, 0) + 1)
                ),
                updated_at = now()
          WHERE id = $1`,
        [skillId],
      );
    },

    async recordVariantFailure(
      skillId: string,
      os: VariantOS,
      downgradeStreak: number,
    ): Promise<DowngradeResult> {
      const { query } = await import("../db/pool.js");
      // fail_streak++（仅对已 connector-verified 的变体计降级，Req 8.6）。
      const res = await query<{ fail_streak: number }>(
        `UPDATE skill_platform_variant
            SET fail_streak = fail_streak + 1
          WHERE skill_id = $1 AND os = $2
        RETURNING fail_streak`,
        [skillId, os],
      );
      const failStreak = res.rows[0]?.fail_streak ?? 0;
      // 降质量分：connector 执行失败按衰减因子下调 success_rate（Req 8.6）。
      await query(
        `UPDATE skill SET success_rate = GREATEST(0, success_rate * 0.8), updated_at = now()
          WHERE id = $1`,
        [skillId],
      );
      // 达阈值 → 降为 unverified（清空 verified_by）。
      const downgraded = failStreak >= downgradeStreak;
      if (downgraded) {
        await query(
          `UPDATE skill_platform_variant
              SET verify_status = 'unverified', verified_by = NULL
            WHERE skill_id = $1 AND os = $2`,
          [skillId, os],
        );
      }
      return { failStreak, downgraded };
    },
  };
}
