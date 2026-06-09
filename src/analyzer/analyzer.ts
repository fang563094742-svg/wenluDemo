/**
 * proactive-awareness-demo —— 分析层 Analyzer（任务 6.1）。
 *
 * 设计依据：design.md「分析层（R5-R7）→ Analyzer（R5）/ Awareness_Item 类型」。
 *
 * 职责：
 *  - 定义本工程「主动察觉条目」的权威类型 `Awareness_Item`（结构与
 *    `orchestrator/session.ts` 中的占位定义一致：`id`/`title`/`rationale`/`evidence`）。
 *  - 定义 `Analyzer` 接口契约：`analyze(summary): Promise<Awareness_Item[]>`（至多 3 条）。
 *  - 提供基于 `LLM_Provider` 的实现 `LlmAnalyzer`：构造「察觉—推断—邀约」三段式 prompt，
 *    用 `jsonSchema` 约束输出为至多 3 条、每条含非空 evidence；LLM 失败抛描述性错误
 *    （由 Orchestrator 捕获后转 `error` 状态、保持服务运行，R5.5/R5.6）。
 *
 * 关键约束：
 *  - 「用户在思考的问题」与「用户需要做的事」视为同一类对象，不作区分（R5.4）。
 *  - 每条 Awareness_Item 必须携带非空 evidence（R5.3）；输出至多 3 条（R5.2）。
 *  - 本任务仅强化 **prompt 设计方向**（证据引用 + 主动推断姿态），**不改变
 *    `Awareness_Item` 的类型结构**（仍为 `title`/`rationale`/`evidence`，附 `id`）。
 *
 * _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6_
 */

import { randomUUID } from "node:crypto";

import type { Scan_Summary } from "../scanner/types.js";
import type { LLM_Provider, LlmRequest } from "../llm/llmProvider.js";

// ===========================================================================
// Awareness_Item 类型（R5）—— 本工程权威来源
// ===========================================================================

/**
 * 主动察觉的单条结果（Analyzer 输出）。
 *
 * 「用户在思考的问题」与「用户需要做的事」被视为同一类对象，统一用本结构表达（R5.4）。
 * 结构与 design.md「Awareness_Item 类型（R5）」一致，且与 `orchestrator/session.ts`
 * 的占位定义字段对齐（最终对齐由编排层任务 14.6 负责）。
 */
export interface Awareness_Item {
  /** 稳定标识，供 UI 接受入口 / 澄清会话引用（R7.2）。 */
  id: string;
  /** 推断出的任务 / 问题简述（「最近最需要做的事」）。 */
  title: string;
  /** 推断理由：须含对 `Scan_Summary` 具体条目的证据引用 + 主动推断姿态。 */
  rationale: string;
  /** 支撑该推断的依据（引用扫描条目；**非空**，R5.3）。 */
  evidence: string[];
}

// ===========================================================================
// Analyzer 接口契约（R5）
// ===========================================================================

/**
 * 分析器：从 `Scan_Summary` 推断用户「最近最需要做的事」。
 */
export interface Analyzer {
  /**
   * 分析扫描摘要，产出**至多 3 条**带非空 evidence 的 `Awareness_Item`（R5.2/R5.3）。
   *
   * @throws {AnalyzerError} LLM 调用失败或输出无法解析时抛描述性错误（R5.5）；
   *         由上层（Orchestrator）捕获后转 `error` 状态并保持服务运行（R5.6）。
   */
  analyze(summary: Scan_Summary): Promise<Awareness_Item[]>;
}

/** 分析阶段的描述性错误（对应 Error Handling 中的 `LlmError` 分级，非致命）。 */
export class AnalyzerError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AnalyzerError";
  }
}

// ===========================================================================
// 输出约束：JSON schema（design.md「输出 JSON schema（Analyzer）」）
// ===========================================================================

/**
 * Analyzer 输出的 JSON schema：至多 3 条，每条含 `title`/`rationale` 及 `minItems: 1`
 * 的 `evidence`（R5.2/R5.3）。作为 `LlmRequest.jsonSchema` 传给 `LLM_Provider`。
 *
 * 注意：schema 是对 LLM 的**约束声明**，不保证供应方严格遵守；`LlmAnalyzer` 在解析后
 * 仍会做防御性校验（截至 3 条、剔除空 evidence 条目），确保 Property 4 成立。
 */
export const ANALYZER_OUTPUT_SCHEMA: object = {
  type: "object",
  properties: {
    items: {
      type: "array",
      maxItems: 3,
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          rationale: { type: "string" },
          evidence: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
          },
        },
        required: ["title", "rationale", "evidence"],
      },
    },
  },
  required: ["items"],
};

/** Analyzer 输出上限（至多 3 条，R5.2）。 */
export const MAX_AWARENESS_ITEMS = 3;

// ===========================================================================
// Prompt 构造（「察觉—推断—邀约」三段式 + 证据引用强制，R5.1/R5.4）
// ===========================================================================

/**
 * 构造 system 段。强制每条察觉以「察觉—推断—邀约」三段式表达，
 * 并强制 `rationale` 含对 `Scan_Summary` 具体条目的证据引用 + 主动推断姿态（R5.1/R5.4）。
 */
export function buildSystemPrompt(): string {
  return [
    "你是问路（Wenlu）的「主动察觉分析器」。",
    "你的任务：仅依据下方设备扫描摘要（Scan_Summary）中的真实条目，推断用户「最近最需要做的事」。",
    "",
    "重要原则：",
    "1. 把「用户正在思考的问题」与「用户需要做的事」视为同一类对象，不作任何区分——两者都用同一条察觉表达。",
    "2. 至多输出 3 条察觉；按「最需要、最有把握」优先排序。",
    "3. 每条察觉必须以「察觉—推断—邀约」三段式组织 rationale：",
    "   - 察觉：「我检测到你最近在…」——引用具体证据（具体文件名/路径、git 提交信息、在用 App 等 Scan_Summary 中的真实条目）。",
    "   - 推断：「我猜你可能在…」——给出有风险的主动推断（大胆推测用户真正想做的事或正卡住的问题），不要含糊其辞。",
    "   - 邀约：「需要我帮你…吗？」——给出一个具体、可执行的邀约。",
    "4. 每条 rationale 必须至少包含一处对 Scan_Summary 具体条目的证据引用，且 evidence 数组中的引用须与 rationale 中提到的证据一致、可回溯到 Scan_Summary。",
    "5. 严禁输出「建议你整理一下文件」这类无证据、无推断的泛泛之谈。无证据支撑就不要编造该条察觉，宁缺毋滥。",
    "6. 若扫描摘要中确实没有可推断的可执行事项，返回空的 items 数组（不要硬凑）。",
    "7. 只对【用户作为人主动创作、编辑、思考】的内容（文档、代码、笔记、正在推进的项目）推断意图；",
    "   坚决【忽略工具 / 系统自动产生的运行时产物】——例如：包管理器日志（.npm / npm 调试日志）、",
    "   AI agent 会话记录（rollout / trajectory / .jsonl 及其 .bak 备份）、各类缓存、锁文件、",
    "   依赖目录（node_modules 等）、插件元数据的版本号 bump（plugin.json version 变更）、",
    "   数据库 WAL/SHM 文件、纯 hash blob、.DS_Store 等。这些是【机器活动】，不代表用户的真实意图。",
    "   若 Scan_Summary 里大多是这类机器噪音，宁可返回更少的察觉或空数组，",
    "   也绝不要硬把机器活动包装成「用户最近在做的事」。",
    "",
    "字段要求（务必逐字段分别填写，不要把所有内容都塞进 rationale）：",
    "- title：必填。一句话的简短任务名（建议 ≤20 字），是「最近最需要做的事」的精炼概括，与 rationale 分开、独立成字段，不要省略、不要留空。",
    "- rationale：必填。上面第 3 点的「察觉—推断—邀约」三段式完整理由。",
    "- evidence：必填。至少一条，引用 Scan_Summary 中的具体条目。",
    "",
    "正确输出字段示例（仅示意字段填写方式，请用扫描摘要中的真实条目）：",
    "{",
    '  "items": [',
    "    {",
    '      "title": "完善年终报告",',
    '      "rationale": "察觉：我检测到你最近在改 report.md……推断：我猜你想把报告定稿……邀约：需要我帮你补全结构吗？",',
    '      "evidence": ["/Users/you/work/report.md", "commit abc123: wip: 草拟年终报告"]',
    "    }",
    "  ]",
    "}",
    "",
    "输出：严格遵守给定的 JSON schema，只返回 JSON，不要输出任何额外解释或 markdown 代码块标记。",
  ].join("\n");
}

/**
 * 构造 user 段：注入 `Scan_Summary` 的 JSON。
 */
export function buildUserPrompt(summary: Scan_Summary): string {
  return [
    "以下是本次设备扫描摘要（Scan_Summary），仅含元信息（文件名/路径/修改时间、git 只读活动、在用 App），不含任何文件正文：",
    "",
    "```json",
    JSON.stringify(summary, null, 2),
    "```",
    "",
    "请据此推断用户「最近最需要做的事」，按上述三段式与证据约束输出至多 3 条察觉。",
  ].join("\n");
}

// ===========================================================================
// LlmAnalyzer —— 基于 LLM_Provider 的实现
// ===========================================================================

/** 解析 LLM JSON 输出时的中间形状（字段均为 unknown，解析后再做防御性校验）。 */
interface RawAnalyzerOutput {
  items?: unknown;
}

/**
 * `Analyzer` 的 LLM 实现：调用 `LLM_Provider.complete`（带 schema 约束），
 * 解析输出并做防御性校验（截至 3 条、剔除空 evidence 条目），为每条分配稳定 id。
 */
export class LlmAnalyzer implements Analyzer {
  private readonly provider: LLM_Provider;
  /** id 生成器（可注入，便于测试得到确定性 id）；默认随机 UUID。 */
  private readonly idFactory: () => string;

  /**
   * @param provider LLM 供应方（经接口注入，不耦合具体实现，R6.1）。
   * @param idFactory 可选 id 生成器，默认 `randomUUID`。
   */
  constructor(provider: LLM_Provider, idFactory: () => string = randomUUID) {
    this.provider = provider;
    this.idFactory = idFactory;
  }

  async analyze(summary: Scan_Summary): Promise<Awareness_Item[]> {
    const req: LlmRequest = {
      system: buildSystemPrompt(),
      messages: [{ role: "user", content: buildUserPrompt(summary) }],
      jsonSchema: ANALYZER_OUTPUT_SCHEMA,
      temperature: 0.4,
    };

    // LLM 调用失败：包装为描述性 AnalyzerError 抛出（上层捕获后保持服务运行，R5.5/R5.6）。
    let text: string;
    try {
      const res = await this.provider.complete(req);
      text = res.text;
    } catch (cause) {
      throw new AnalyzerError(
        `分析阶段调用 LLM 失败：${describeError(cause)}。服务保持可继续运行。`,
        { cause },
      );
    }

    // 解析 + 防御性校验：截至 3 条、每条 evidence 非空（保证 Property 4）。
    const raw = parseAnalyzerJson(text);
    return this.normalizeItems(raw);
  }

  /**
   * 将解析出的原始 items 规整为合法 `Awareness_Item[]`：
   *  - 丢弃 rationale 为空或 evidence 为空的条目（evidence 非空是硬要求，R5.3 / Property 4）；
   *  - title 缺失/空但 rationale 非空时，从 rationale 自动派生简短 title（健壮性兜底，不丢弃）；
   *  - 截至至多 3 条（R5.2）；
   *  - 为每条分配稳定 id。
   */
  private normalizeItems(raw: RawAnalyzerOutput): Awareness_Item[] {
    const rawItems = Array.isArray(raw.items) ? raw.items : [];
    const result: Awareness_Item[] = [];

    for (const candidate of rawItems) {
      if (result.length >= MAX_AWARENESS_ITEMS) break;
      const item = this.toAwarenessItem(candidate);
      if (item !== null) result.push(item);
    }
    return result;
  }

  /**
   * 将单个候选对象转为 `Awareness_Item`；不合法返回 null。
   *
   * 健壮性兜底（真实模型常不严格遵守 schema）：真实 GPT-5.4 会把全部内容塞进
   * `rationale` 而漏给 `title`（尽管 schema 把 title 列为 required）。为避免「整条丢弃 →
   * 0 条察觉 → 闭环第一步即断」，此处当 `title` 缺失/空但 `rationale` 非空时，
   * **不丢弃**该条，而是用 `deriveTitleFromRationale` 从 rationale 自动派生简短 title。
   *
   * 丢弃条件仅两项（保持 Property 4：≤3 条、每条 evidence 非空）：
   *  - `evidence` 为空（硬要求，不兜底，R5.3）；
   *  - `rationale` 为空（既无 title 又无可派生内容，无任何可呈现信息）。
   */
  private toAwarenessItem(candidate: unknown): Awareness_Item | null {
    if (typeof candidate !== "object" || candidate === null) return null;
    const obj = candidate as Record<string, unknown>;

    const rawTitle = typeof obj.title === "string" ? obj.title.trim() : "";
    const rationale = typeof obj.rationale === "string" ? obj.rationale.trim() : "";

    const evidence = Array.isArray(obj.evidence)
      ? obj.evidence
          .filter((e): e is string => typeof e === "string")
          .map((e) => e.trim())
          .filter((e) => e.length > 0)
      : [];
    // 每条 Awareness_Item 必须含非空 evidence（R5.3 / Property 4，硬要求，绝不兜底）。
    if (evidence.length === 0) return null;
    // rationale 为空 → 无 title 也无可派生内容，整条无可呈现信息，丢弃。
    if (rationale.length === 0) return null;

    // title 缺失/空时从 rationale 派生（rationale 已保证非空，派生结果非空）。
    const title = rawTitle.length > 0 ? rawTitle : deriveTitleFromRationale(rationale);

    return { id: this.idFactory(), title, rationale, evidence };
  }
}

// ===========================================================================
// 解析兜底：从 rationale 派生简短 title（健壮性，应对模型漏给 title）
// ===========================================================================

/** 派生 title 的字符上限（截断到合理长度，避免标题过长）。 */
export const DERIVED_TITLE_MAX_LEN = 40;

/** 三段式 / 常见前缀（如「察觉：」「推断：」），派生 title 前剥离。 */
const TITLE_PREFIX_RE = /^(察觉|推断|邀约|任务|问题|建议)\s*[：:、.\-—]+\s*/;

/** 句末 / 分隔标点（取第一个句子用）。 */
const SENTENCE_BREAK_RE = /^[^。！？!?\n；;]+/;

/**
 * 从 rationale 派生一个简短 title（仅在模型漏给 title 时使用）。
 *
 * 步骤：
 *  1. 去除「察觉：」「推断：」之类三段式前缀（可重复出现，循环剥离）；
 *  2. 取第一个句子（在首个句末/分隔标点处截断）；
 *  3. 截断到 `DERIVED_TITLE_MAX_LEN` 字符（超出补省略号）。
 *
 * @param rationale 已 trim 的非空 rationale；返回值在入参非空时保证非空。
 */
export function deriveTitleFromRationale(rationale: string): string {
  let text = rationale.trim();
  if (text.length === 0) return "";

  // 1) 循环剥离三段式 / 常见前缀。
  while (TITLE_PREFIX_RE.test(text)) {
    const stripped = text.replace(TITLE_PREFIX_RE, "").trim();
    if (stripped === text) break; // 防御：无实际变化则停止，避免死循环
    text = stripped;
  }

  // 2) 取第一个句子；若全是标点导致句子为空，退化为剥离后的整段。
  const sentenceMatch = text.match(SENTENCE_BREAK_RE);
  let title = (sentenceMatch ? sentenceMatch[0] : text).trim();
  if (title.length === 0) title = text;

  // 3) 截断到上限（超出补省略号）。
  if (title.length > DERIVED_TITLE_MAX_LEN) {
    title = title.slice(0, DERIVED_TITLE_MAX_LEN).trim() + "…";
  }
  return title;
}

// ===========================================================================
// 辅助：JSON 解析与错误描述
// ===========================================================================

/**
 * 解析 LLM 文本为 `RawAnalyzerOutput`。
 *
 * 容错：优先直接 `JSON.parse`；失败时尝试剥离 ```json fences / 提取首个 `{...}` 块再解析。
 * 仍无法解析则抛描述性 `AnalyzerError`（R5.5）。
 */
export function parseAnalyzerJson(text: string): RawAnalyzerOutput {
  const candidates = collectJsonCandidates(text);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (typeof parsed === "object" && parsed !== null) {
        return parsed as RawAnalyzerOutput;
      }
    } catch {
      // 尝试下一个候选
    }
  }
  throw new AnalyzerError(
    "分析阶段无法解析 LLM 返回的 JSON 输出（不符合预期结构）。服务保持可继续运行。",
  );
}

/** 从文本中收集可能的 JSON 串候选：原文、去除 markdown 代码块标记、首尾大括号截取。 */
function collectJsonCandidates(text: string): string[] {
  const trimmed = text.trim();
  const candidates: string[] = [trimmed];

  // 去除 ```json ... ``` 或 ``` ... ``` 围栏。
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch && typeof fenceMatch[1] === "string") {
    candidates.push(fenceMatch[1].trim());
  }

  // 截取首个 '{' 到末个 '}' 之间的内容。
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    candidates.push(trimmed.slice(start, end + 1));
  }

  return candidates;
}

/** 把未知错误对象转为可读字符串（用于描述性错误信息）。 */
function describeError(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  try {
    return JSON.stringify(cause);
  } catch {
    return String(cause);
  }
}
