/**
 * proactive-awareness-demo —— 配置层（任务 2.1）。
 *
 * 职责：
 *  - 从环境变量读取 GPT-5.4 API key（绝不硬编码），读取优先级：优先 `OPENAI_API_KEY`，
 *    次选 `GPT_API_KEY`；两者都缺时返回可识别的"key 缺失"错误，供启动校验逻辑使用
 *    （不直接抛进程崩溃，是否优雅终止由 composition root 决定，R6.3/R6.4）。
 *  - 集中定义并导出全工程可配置项与安全护栏常量（白名单/黑名单/阈值/超时/澄清上限）。
 *
 * 安全原则：API key 仅从环境变量读取，源码不出现任何明文 key（R6.3）。
 *
 * _Requirements: 6.3, 9.2, 11.1, 13.2, 16.3, 8.4, 8.12, 8.13_
 */

import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// GPT-5.4 API key 读取与校验（R6.3）
// ---------------------------------------------------------------------------

/** API key 读取来源标识，用于诊断与日志（不含 key 值本身）。 */
export type ApiKeySource = "OPENAI_API_KEY" | "GPT_API_KEY";

/**
 * API key 读取结果。
 * - 成功：`ok === true`，`apiKey` 为非空 key，`source` 标识命中的环境变量名。
 * - 缺失：`ok === false`，`error` 为描述性错误信息（供启动校验呈现/记录）。
 *
 * 注意：失败时返回可识别的错误对象，而非抛异常崩溃进程——是否据此优雅终止启动
 * 交由 composition root（任务 17.1）决定（R6.4）。
 */
export type ApiKeyResult =
  | { ok: true; apiKey: string; source: ApiKeySource }
  | { ok: false; error: string };

/** 按优先级（OPENAI_API_KEY 优先，GPT_API_KEY 次选）尝试的环境变量名。 */
export const API_KEY_ENV_VARS: readonly ApiKeySource[] = ["OPENAI_API_KEY", "GPT_API_KEY"];

/**
 * 从环境变量读取 GPT-5.4 API key（绝不硬编码）。
 *
 * 读取优先级：
 *   1. `OPENAI_API_KEY`（优先）
 *   2. `GPT_API_KEY`（次选）
 * 两者皆缺（或仅含空白）时返回可识别的"key 缺失"错误，供启动校验使用。
 *
 * @param env 环境变量来源，默认 `process.env`（注入便于测试）。
 */
export function readApiKey(env: NodeJS.ProcessEnv = process.env): ApiKeyResult {
  for (const source of API_KEY_ENV_VARS) {
    const raw = env[source];
    const value = typeof raw === "string" ? raw.trim() : "";
    if (value.length > 0) {
      return { ok: true, apiKey: value, source };
    }
  }
  return {
    ok: false,
    error:
      "缺少 GPT-5.4 API key：未在环境变量中找到 OPENAI_API_KEY（优先）或 GPT_API_KEY（次选）。" +
      "请在 .env 或运行环境中设置其中之一（参见 .env.example）。",
  };
}

// ---------------------------------------------------------------------------
// GPT-5.4 baseURL / model 读取（与 readApiKey 同风格，支持从环境变量读取）
// ---------------------------------------------------------------------------

/**
 * LLM base URL 环境变量名。
 *
 * 该 key 指向 OpenAI 兼容的中转端点；当配置的 API key 属于第三方中转端点时，必须配合
 * 此 base URL 才有效（Bug 7 修复：让 baseURL 像 apiKey 一样可从环境变量读取）。
 */
export const BASE_URL_ENV_VAR = "WENLU_LLM_BASE_URL";

/** LLM 模型名环境变量名（Bug 7 修复：让 model 可从环境变量读取）。 */
export const MODEL_ENV_VAR = "WENLU_LLM_MODEL";

/**
 * 从环境变量读取 LLM base URL（`WENLU_LLM_BASE_URL`，绝不硬编码具体端点）。
 *
 * trim 后非空则返回，空或缺失返回 `undefined`（交由调用方回退默认值）。
 *
 * @param env 环境变量来源，默认 `process.env`（注入便于测试）。
 */
export function readBaseUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env[BASE_URL_ENV_VAR];
  const value = typeof raw === "string" ? raw.trim() : "";
  return value.length > 0 ? value : undefined;
}

/**
 * 从环境变量读取 LLM 模型名（`WENLU_LLM_MODEL`）。
 *
 * trim 后非空则返回，空或缺失返回 `undefined`（交由调用方回退默认值）。
 *
 * @param env 环境变量来源，默认 `process.env`（注入便于测试）。
 */
export function readModel(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env[MODEL_ENV_VAR];
  const value = typeof raw === "string" ? raw.trim() : "";
  return value.length > 0 ? value : undefined;
}

/**
 * 读取并校验 API key，缺失时仅返回错误信息（不抛异常）。
 * 供启动校验逻辑使用：调用方可据 `error` 决定是否优雅终止启动（R6.4）。
 *
 * @returns key 可用时 `error` 为 `null`；缺失时 `apiKey` 为 `null` 且 `error` 为描述性信息。
 */
export function validateApiKey(env: NodeJS.ProcessEnv = process.env): {
  apiKey: string | null;
  source: ApiKeySource | null;
  error: string | null;
} {
  const result = readApiKey(env);
  if (result.ok) {
    return { apiKey: result.apiKey, source: result.source, error: null };
  }
  return { apiKey: null, source: null, error: result.error };
}

// ---------------------------------------------------------------------------
// 安全护栏：命令白名单（R13.2）
// ---------------------------------------------------------------------------

/**
 * 安全命令白名单（demo 阶段可相对宽松，但兜底门必须存在）。
 *
 * `HighRiskGuard` 在黑名单之上叠加白名单兜底：`run_command` 的主命令若不在本白名单内，
 * 一律视为高危走确认弹窗（R13.2）。
 *
 * 安全修正：`curl` 与 `wget` **刻意不纳入默认白名单**——它们可向任意网络地址外传
 * 代码/数据，构成数据外泄通道，默认触发高危确认；用户可按需自行加入。
 */
export const SAFE_COMMAND_WHITELIST: string[] = [
  "npm", "npx", "yarn", "pnpm", "node", "python", "python3",
  "git", // git 的 force push 仍被黑名单拦截
  "make", "cmake",
  "ls", "cat", "head", "tail", "grep",
  "find", // 保留为只读检索；其 -delete/-exec 用法由黑名单优先拦为高危
  "wc", "sort", "uniq", "diff", "echo",
  "mkdir", "touch", "cp", "mv", // mv/cp 保留，但仍受 sandbox 校验（可能跨界）
  // 只读断言原语：`test -f`/`test -d`/`[ -f … ]` 等仅做存在性/类型判定，无副作用。
  // 验收阶段 Acceptance_Test 常用其查退出码，纳入白名单以免被高危门误拦（curl/wget 仍刻意排除）。
  "test", "[",
];

// ---------------------------------------------------------------------------
// 安全护栏：关键目录黑名单（R9.2）
// ---------------------------------------------------------------------------

/**
 * 关键目录黑名单（规范化绝对路径比较）。
 *
 * `Scope_Resolver.confirm` 在落定 Working_Directory 前先做此校验：拒绝把过宽/过敏感的
 * 根目录设为 sandbox 根（这类目录会导致备份体积爆炸、Executor 操作面过大）。
 * 命中则抛 `ScopeError` 要求用户另选更聚焦的目录（R9.2/R9.3）。
 */
export const CRITICAL_DIR_BLACKLIST: string[] = [
  "/",
  "/Users",
  "/home",
  "/etc",
  "/var",
  "/System",
  "/Library",
  "/usr",
  "/bin",
  homedir(), // 用户主目录本身
];

// ---------------------------------------------------------------------------
// 备份护栏：体积阈值与遍历忽略项（R11.1）
// ---------------------------------------------------------------------------

/** 备份体积警告阈值（默认 500MB，可调）。超过则需用户二次确认（R11.1）。 */
export const BACKUP_SIZE_WARN_BYTES = 500 * 1024 * 1024;

/**
 * 备份体积估算与快照创建时跳过的目录（可配置）。
 *
 * `.git` 必须在内：否则 `estimateDirSize` 会进入 `.git/objects`，既慢又使体积估算严重失真；
 * `.pad-backups` 排除自身可防无限递归 / 体积爆炸；`node_modules` 体积大且可重建。
 */
export const BACKUP_IGNORE_DIRS: string[] = [".pad-backups", "node_modules", ".git"];

// ---------------------------------------------------------------------------
// 执行超时常量（防止 sleep/死循环挂死流程）
// ---------------------------------------------------------------------------

/** `run_command` 通用执行超时，默认 60s，可配置。超时即终止子进程并回灌为非致命 failed。 */
export const RUN_COMMAND_TIMEOUT_MS = 60_000;

/** 每条验收测试 checkMethod 的超时，默认 10s，可配置。超时视为该测试 failed（不挂死流程）。 */
export const ACCEPTANCE_TEST_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Web 服务：UI 就绪握手超时（R16.3）
// ---------------------------------------------------------------------------

/** UI 就绪握手超时（毫秒），默认 3000。超时未收到 ui-ready 即判定 UI 初始化失败并自毁（R16.3）。 */
export const uiReadyTimeoutMs = 3000;

// ---------------------------------------------------------------------------
// Clarifier 充分性判定相关上限（R8.4 / R8.12 / R8.13）
// ---------------------------------------------------------------------------

/** 澄清轮次软上限，默认 8。`round >= maxRounds` 仍有高风险模糊前提 → 进入 impasse（R8.12）。 */
export const maxRounds = 8;

/** 单轮澄清提问数量上限，默认 3（R8.4）。注意：仅限制单轮提问数，不限制逻辑阶段数（R8.5）。 */
export const perRoundQuestionLimit = 3;

/** 顶层逻辑阶段过多阈值，默认 6。超过则主动抛出"收敛聚焦建议"澄清问题（R8.13）。 */
export const topPhaseConvergenceThreshold = 6;
