/**
 * shellClassifier.ts — execute_command 逃生口治理。
 *
 * 问题：execute_command 不是一个工具，而是一个"工具虚拟机"。
 * 它能读文件、写文件、联网、改权限、启进程、调数据库——
 * 语义是无限多个，单一标签无法覆盖。
 *
 * 解决方案：对每次 execute_command 调用做二次分类，
 * 给出真实的语义子类型，让 pipeline/cache/conflict/compose 系统能正确推理。
 *
 * 分类结果不改变执行，但改变调度决策：
 * - shell-read → 可并行、可缓存
 * - shell-write → 需串行、需 checkpoint
 * - shell-network → 受 rate limit、受 budget
 * - shell-process → 需隔离
 * - shell-destructive → 需人工确认
 */

import type { ToolSemantics, Purity } from "../tools/toolSemantics.js";

// ═══════════════════════════════════════════════════════════════════════
// Shell 子类型
// ═══════════════════════════════════════════════════════════════════════

export type ShellSubtype =
  | "shell-read"         // 纯读（cat, ls, find, grep, which, echo）
  | "shell-write"        // 文件写入（cp, mv, mkdir, touch, tee, >）
  | "shell-network"      // 网络（curl, wget, ping, nc, ssh）
  | "shell-package"      // 包管理（npm, pip, brew, apt）
  | "shell-process"      // 进程管理（kill, ps, lsof, open）
  | "shell-git"          // 版本控制（git 全家桶）
  | "shell-build"        // 编译构建（make, tsc, gcc, cargo）
  | "shell-destructive"  // 破坏性（rm -rf, drop, truncate）
  | "shell-unknown"      // 无法归类
  ;

export interface ShellClassification {
  subtype: ShellSubtype;
  confidence: number;  // 0-1
  semantics: Partial<ToolSemantics>;
  riskLevel: "safe" | "moderate" | "dangerous";
  requiresConfirmation: boolean;
}

// ═══════════════════════════════════════════════════════════════════════
// 分类规则
// ═══════════════════════════════════════════════════════════════════════

interface ClassificationRule {
  subtype: ShellSubtype;
  patterns: RegExp[];
  antiPatterns?: RegExp[];
  purity: Purity;
  riskLevel: "safe" | "moderate" | "dangerous";
  rollbackable: boolean;
  requiresNetwork: boolean;
}

const RULES: ClassificationRule[] = [
  {
    subtype: "shell-destructive",
    patterns: [
      /\brm\s+-[a-z]*r[a-z]*f/,       // rm -rf
      /\brm\s+-[a-z]*f[a-z]*r/,       // rm -fr
      /\bdrop\s+(database|table)/i,
      /\btruncate\b/i,
      />\s*\/dev\/null.*2>&1/,          // 吞输出的可能在隐藏问题
      /\bformat\b/i,
      /\bdd\s+.*of=/,
    ],
    purity: "destructive",
    riskLevel: "dangerous",
    rollbackable: false,
    requiresNetwork: false,
  },
  {
    subtype: "shell-network",
    patterns: [
      /\bcurl\b/,
      /\bwget\b/,
      /\bping\b/,
      /\bnc\s/,
      /\bssh\b/,
      /\bscp\b/,
      /\brsync\b.*:/,
      /\bfetch\b/,
      /https?:\/\//,
    ],
    purity: "non-idempotent-write",
    riskLevel: "moderate",
    rollbackable: false,
    requiresNetwork: true,
  },
  {
    subtype: "shell-git",
    patterns: [
      /\bgit\s/,
    ],
    antiPatterns: [
      /\bgit\s+(log|status|diff|show|branch|stash\s+list)/,  // 这些是只读的
    ],
    purity: "non-idempotent-write",
    riskLevel: "moderate",
    rollbackable: true,
    requiresNetwork: false,
  },
  {
    subtype: "shell-package",
    patterns: [
      /\bnpm\s+(install|uninstall|update|publish)/,
      /\byarn\s+(add|remove|upgrade)/,
      /\bpnpm\s+(install|add|remove)/,
      /\bpip\s+(install|uninstall)/,
      /\bbrew\s+(install|uninstall|upgrade)/,
      /\bapt(-get)?\s+(install|remove|purge)/,
    ],
    purity: "non-idempotent-write",
    riskLevel: "moderate",
    rollbackable: false,
    requiresNetwork: true,
  },
  {
    subtype: "shell-build",
    patterns: [
      /\bmake\b/,
      /\btsc\b/,
      /\bgcc\b/,
      /\bcargo\s+build/,
      /\bnpm\s+run\s+build/,
      /\bwebpack\b/,
      /\bvite\s+build/,
    ],
    purity: "idempotent-write",
    riskLevel: "safe",
    rollbackable: true,
    requiresNetwork: false,
  },
  {
    subtype: "shell-process",
    patterns: [
      /\bkill\b/,
      /\bkillall\b/,
      /\bpkill\b/,
      /\blsof\b/,
      /\bps\s/,
      /\bopen\s/,
      /\blaunchctl\b/,
      /\bsystemctl\b/,
    ],
    purity: "non-idempotent-write",
    riskLevel: "moderate",
    rollbackable: false,
    requiresNetwork: false,
  },
  {
    subtype: "shell-write",
    patterns: [
      /\bcp\s/,
      /\bmv\s/,
      /\bmkdir\b/,
      /\btouch\b/,
      /\btee\b/,
      /\bchmod\b/,
      /\bchown\b/,
      />\s*[^&]/,           // 输出重定向
      />>/,                  // 追加重定向
      /\bsed\s+-i/,         // in-place sed
    ],
    antiPatterns: [
      /\bcat\b/,   // cat 是读
    ],
    purity: "non-idempotent-write",
    riskLevel: "moderate",
    rollbackable: true,
    requiresNetwork: false,
  },
  {
    subtype: "shell-read",
    patterns: [
      /\bcat\b/,
      /\bls\b/,
      /\bfind\b/,
      /\bgrep\b/,
      /\bwhich\b/,
      /\bwho\b/,
      /\becho\b/,
      /\bhead\b/,
      /\btail\b/,
      /\bwc\b/,
      /\bfile\b/,
      /\bstat\b/,
      /\bdu\b/,
      /\bdf\b/,
      /\bpwd\b/,
      /\benv\b/,
      /\bprintenv\b/,
      /\buname\b/,
      /\bgit\s+(log|status|diff|show|branch|stash\s+list)/,
    ],
    purity: "pure-read",
    riskLevel: "safe",
    rollbackable: true,
    requiresNetwork: false,
  },
];

// ═══════════════════════════════════════════════════════════════════════
// 分类器
// ═══════════════════════════════════════════════════════════════════════

export function classifyShellCommand(command: string): ShellClassification {
  const normalized = command.trim();

  // 管道链：取风险最高的子命令
  const pipeSegments = normalized.split(/\s*\|\s*/);
  const segmentClassifications = pipeSegments.map(seg => classifySingleSegment(seg));

  // 取风险最高的分类
  const riskOrder: Record<string, number> = { safe: 0, moderate: 1, dangerous: 2 };
  segmentClassifications.sort((a, b) => riskOrder[b.riskLevel] - riskOrder[a.riskLevel]);
  const highest = segmentClassifications[0];

  // 管道整体如果包含写命令，整体不可缓存
  const hasWrite = segmentClassifications.some(c =>
    c.subtype !== "shell-read" && c.subtype !== "shell-unknown"
  );

  return {
    ...highest,
    semantics: {
      ...highest.semantics,
      purity: hasWrite ? highest.semantics.purity : "pure-read",
    },
  };
}

function classifySingleSegment(segment: string): ShellClassification {
  for (const rule of RULES) {
    const matchesPattern = rule.patterns.some(p => p.test(segment));
    const matchesAnti = rule.antiPatterns?.some(p => p.test(segment));

    if (matchesPattern && !matchesAnti) {
      return {
        subtype: rule.subtype,
        confidence: 0.85,
        semantics: {
          purity: rule.purity,
          rollbackable: rule.rollbackable,
          requiresNetwork: rule.requiresNetwork,
          costClass: rule.requiresNetwork ? "moderate" : "cheap",
        } as Partial<ToolSemantics>,
        riskLevel: rule.riskLevel,
        requiresConfirmation: rule.riskLevel === "dangerous",
      };
    }
  }

  return {
    subtype: "shell-unknown",
    confidence: 0.3,
    semantics: {
      purity: "non-idempotent-write",  // 保守假设
      rollbackable: false,
      requiresNetwork: false,
      costClass: "cheap",
    } as Partial<ToolSemantics>,
    riskLevel: "moderate",
    requiresConfirmation: false,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// 供 pipeline/cache/conflict 系统使用的快捷判断
// ═══════════════════════════════════════════════════════════════════════

export function isShellReadOnly(command: string): boolean {
  const classification = classifyShellCommand(command);
  return classification.subtype === "shell-read";
}

export function isShellDestructive(command: string): boolean {
  const classification = classifyShellCommand(command);
  return classification.riskLevel === "dangerous";
}

export function shellConflictKeys(command: string): string[] {
  const classification = classifyShellCommand(command);
  const keys: string[] = [];

  switch (classification.subtype) {
    case "shell-git":
      keys.push("git-repo");
      break;
    case "shell-package":
      keys.push("package-manifest");
      break;
    case "shell-process":
      keys.push("process-table");
      break;
    case "shell-network":
      keys.push("network-io");
      break;
  }

  // 提取目标文件路径作为冲突键
  const fileMatch = command.match(/(?:^|\s)((?:\/|\.\/|\~\/)[^\s;|&>]+)/);
  if (fileMatch && classification.subtype !== "shell-read") {
    keys.push(`file:${fileMatch[1]}`);
  }

  return keys;
}
