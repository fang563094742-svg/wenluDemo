/**
 * 技能复利飞轮 · Component 1：可反哺规格 SkillSpec + 去隐私 + 适用条件（skill-spec.ts）
 * ------------------------------------------------------------------
 * 技能从诞生即按"可反哺规格"设计：值/结构分离 + 多维分类标签 + 平台契约 + 验证契约。
 * 一期本地用，二期接云反哺通道不返工。
 * _Requirements: 1.1-1.6, 6.3_
 */

import { randomUUID } from "node:crypto";

export type SkillPlatform = "mac" | "win" | "linux" | "any";

/** 多维分类标签（二期按行业/软件/任务类型反哺分类的依据）。 */
export interface SkillTaxonomy {
  industry?: string;
  app?: string;
  taskType: string;
}

/** 客观验证契约：技能"真有效"由它客观裁定，不靠自评。 */
export interface SkillVerifyContract {
  kind: "exit-code" | "state-assert" | "diff-check";
  /** 验证规格（命令/断言表达式），同样值结构分离用 ${var} 占位。 */
  spec: string;
}

/** 执行体单步：args 的值一律用 ${var} 占位（值/结构分离）。 */
export interface SkillExecStep {
  op: string;
  args: Record<string, string>;
}

export interface SkillSpec {
  id: string;
  name: string;
  /** 适用条件。 */
  when: { taskPattern: string; preconditions: string[] };
  /** 值/结构分离的执行体：vars 列出占位变量，steps 只保留结构。 */
  exec: { vars: string[]; steps: SkillExecStep[] };
  /** 终止判据。 */
  done: string;
  /** 客观验证契约。 */
  verify: SkillVerifyContract;
  /** 平台契约。 */
  platform: SkillPlatform[];
  /** 平台专属(true，不可跨平台) / 可适配(false)。 */
  platformLocked: boolean;
  /** 多维分类标签。 */
  taxonomy: SkillTaxonomy;
  /** 来源与信誉。 */
  provenance: { createdAt: string; verifiedCount: number; totalCount: number };
}

export function newSkillId(): string {
  return `skill_${randomUUID()}`;
}

/** 隐私值模式：绝对路径 / 邮箱 / token 样式 / IPv4 / 用户名目录。 */
const PRIVACY_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\/Users\/[^/\s$]+/, label: "mac-user-path" },
  { re: /[A-Za-z]:\\Users\\[^\\\s]+/, label: "win-user-path" },
  { re: /\/home\/[^/\s$]+/, label: "linux-user-path" },
  { re: /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i, label: "email" },
  { re: /\b(sk|pk|ghp|xox[baprs])[-_][A-Za-z0-9]{10,}/, label: "token" },
  { re: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/, label: "ipv4" },
];

/** 去隐私化校验：exec(+verify) 不得残留具体隐私值。${var} 占位不算泄露。 */
export function scanResidualPrivacy(spec: SkillSpec): { clean: boolean; leaks: string[] } {
  const leaks: string[] = [];
  const texts: string[] = [];
  for (const s of spec.exec?.steps ?? []) {
    for (const v of Object.values(s.args ?? {})) texts.push(String(v));
  }
  texts.push(spec.verify?.spec ?? "");
  texts.push(spec.when?.taskPattern ?? "");
  for (const t of texts) {
    // 把 ${var} 占位挖空后再扫描——占位本身不是泄露。
    const stripped = t.replace(/\$\{[^}]+\}/g, "");
    for (const p of PRIVACY_PATTERNS) {
      if (p.re.test(stripped)) leaks.push(`${p.label}: ${stripped.match(p.re)?.[0]?.slice(0, 40)}`);
    }
  }
  return { clean: leaks.length === 0, leaks };
}

/**
 * 语义相关度：taskDesc 对 spec.when.taskPattern 的 token 命中率加权分数。
 * 返回 0~1。短 token 权重低于长 token（简易 IDF 代理）。
 */
export function skillRelevance(spec: SkillSpec, taskDesc: string, platform: SkillPlatform): number {
  if (!spec) return 0;
  const platformOk = spec.platform.includes("any") || spec.platform.includes(platform);
  if (!platformOk) return 0;
  const desc = (taskDesc ?? "").toLowerCase();
  const pattern = (spec.when?.taskPattern ?? "").toLowerCase();
  if (!pattern) return 0;
  const tokens = tokenize(pattern);
  if (tokens.length === 0) return 0;
  let weightSum = 0;
  let hitWeight = 0;
  for (const t of tokens) {
    const w = Math.log2(1 + t.length);
    weightSum += w;
    if (desc.includes(t)) hitWeight += w;
  }
  return weightSum > 0 ? hitWeight / weightSum : 0;
}

/** 适用条件匹配：任务描述 + 平台 是否命中本技能。 */
export function skillMatches(spec: SkillSpec, taskDesc: string, platform: SkillPlatform, minRelevance = 0): boolean {
  const rel = skillRelevance(spec, taskDesc, platform);
  if (minRelevance > 0) return rel >= minRelevance;
  return rel > 0;
}

/** 切 token：英文按分隔，中文加 2-gram。 */
function tokenize(text: string): string[] {
  const t = (text ?? "").trim().toLowerCase();
  if (!t) return [];
  const coarse = t.split(/[^a-z0-9\u4e00-\u9fa5]+/).filter((x) => x.length >= 2);
  const grams: string[] = [];
  for (const seg of coarse) {
    if (/[\u4e00-\u9fa5]/.test(seg) && seg.length >= 2) {
      for (let i = 0; i < seg.length - 1; i++) grams.push(seg.slice(i, i + 2));
    }
  }
  return [...coarse, ...grams];
}

/** 反哺规格完整性校验：二期反哺所需字段是否齐全。 */
export function isReshareReady(spec: SkillSpec): boolean {
  return (
    !!spec.taxonomy?.taskType &&
    Array.isArray(spec.platform) && spec.platform.length > 0 &&
    !!spec.verify?.kind &&
    Array.isArray(spec.exec?.vars) &&
    !!spec.provenance
  );
}
