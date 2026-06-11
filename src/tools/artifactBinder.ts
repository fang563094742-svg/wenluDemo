/**
 * artifactBinder.ts — 工具间 I/O 转换层。
 *
 * 解决的问题：
 * - list_directory 输出"目录列表"，read_file 需要"具体路径"
 * - web_search 输出"搜索结果列表"，browse_url 需要"单个 URL"
 * - 光有 outputArtifacts 匹配 inputArtifacts 不够——中间需要选择器/提取器
 *
 * 职责：
 * 1. 定义 artifact 间的转换规则
 * 2. 自动生成 pipeline 中间的 binder 步骤
 * 3. 让 typedComposer 知道"类型表面兼容"和"真正可执行兼容"的区别
 */

import type { ArtifactTypeKind } from "./toolSemantics.js";

// ═══════════════════════════════════════════════════════════════════════
// Binder 规则
// ═══════════════════════════════════════════════════════════════════════

export interface BinderRule {
  from: ArtifactTypeKind;
  to: ArtifactTypeKind;
  extractorName: string;
  description: string;
  extractFn: (output: unknown) => unknown[];
}

// ═══════════════════════════════════════════════════════════════════════
// 内置 Binder 规则
// ═══════════════════════════════════════════════════════════════════════

export const BUILTIN_BINDERS: BinderRule[] = [
  {
    from: "directory-listing",
    to: "path-list",
    extractorName: "dir-to-paths",
    description: "从目录列表中提取所有文件路径",
    extractFn: (output: unknown) => {
      if (typeof output === "string") {
        return output.split("\n").filter(l => l.trim().length > 0);
      }
      if (Array.isArray(output)) return output;
      return [];
    },
  },
  {
    from: "search-results",
    to: "path-list",
    extractorName: "search-to-urls",
    description: "从搜索结果中提取 URL 列表",
    extractFn: (output: unknown) => {
      if (typeof output === "string") {
        const urlPattern = /https?:\/\/[^\s"'<>]+/g;
        return output.match(urlPattern) ?? [];
      }
      if (Array.isArray(output)) {
        return output.map((item: any) => item.url ?? item.link ?? item).filter(Boolean);
      }
      return [];
    },
  },
  {
    from: "command-output",
    to: "structured-json",
    extractorName: "stdout-to-json",
    description: "尝试解析命令输出为 JSON",
    extractFn: (output: unknown) => {
      if (typeof output !== "string") return [];
      try {
        const parsed = JSON.parse(output);
        return [parsed];
      } catch {
        return [];
      }
    },
  },
  {
    from: "command-output",
    to: "path-list",
    extractorName: "stdout-to-paths",
    description: "从命令输出中按行提取路径",
    extractFn: (output: unknown) => {
      if (typeof output !== "string") return [];
      return output.split("\n").filter(l => l.trim().startsWith("/") || l.trim().startsWith("./"));
    },
  },
  {
    from: "file-content",
    to: "structured-json",
    extractorName: "file-to-json",
    description: "解析文件内容为 JSON",
    extractFn: (output: unknown) => {
      if (typeof output !== "string") return [];
      try {
        return [JSON.parse(output)];
      } catch {
        return [];
      }
    },
  },
  {
    from: "web-page-content",
    to: "path-list",
    extractorName: "page-to-links",
    description: "从网页内容中提取链接",
    extractFn: (output: unknown) => {
      if (typeof output !== "string") return [];
      const linkPattern = /https?:\/\/[^\s"'<>]+/g;
      return output.match(linkPattern) ?? [];
    },
  },
];

// ═══════════════════════════════════════════════════════════════════════
// ArtifactBinder
// ═══════════════════════════════════════════════════════════════════════

export interface ArtifactBinder {
  canBind(from: ArtifactTypeKind, to: ArtifactTypeKind): boolean;
  getBinder(from: ArtifactTypeKind, to: ArtifactTypeKind): BinderRule | null;
  bind(from: ArtifactTypeKind, to: ArtifactTypeKind, output: unknown): unknown[];
  allRules(): BinderRule[];
  addRule(rule: BinderRule): void;
}

export function createArtifactBinder(extraRules?: BinderRule[]): ArtifactBinder {
  const rules: BinderRule[] = [...BUILTIN_BINDERS, ...(extraRules ?? [])];

  function canBind(from: ArtifactTypeKind, to: ArtifactTypeKind): boolean {
    return rules.some(r => r.from === from && r.to === to);
  }

  function getBinder(from: ArtifactTypeKind, to: ArtifactTypeKind): BinderRule | null {
    return rules.find(r => r.from === from && r.to === to) ?? null;
  }

  function bind(from: ArtifactTypeKind, to: ArtifactTypeKind, output: unknown): unknown[] {
    const rule = getBinder(from, to);
    if (!rule) return [];
    return rule.extractFn(output);
  }

  function allRules(): BinderRule[] {
    return [...rules];
  }

  function addRule(rule: BinderRule): void {
    rules.push(rule);
  }

  return { canBind, getBinder, bind, allRules, addRule };
}
