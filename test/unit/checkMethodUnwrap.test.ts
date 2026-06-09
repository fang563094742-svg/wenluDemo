// Bug 5 回归（真实 GPT-5.4 端到端暴露）：`classifyCheckMethod` 自然语言包裹解包。
//
// **Validates: Requirements 15.1, 12.5**
//
// 现象：经 Clarifier 的 sufficient 分支产出的真实 `Acceptance_Test.checkMethod` 常为
// 「自然语言包裹」形态——真正要执行的命令在反引号 `` ` `` 内，外层是
// "运行 …… 并检查退出码为 0。" 这类中文散文。若不解包，整串被当成 shell 命令、
// 首 token（"运行"）不在白名单 → 被高危门误拦 → 验收误判 failed。
//
// 本文件用确定性示例锚定解包后的分类结果：NL 包裹的 shell/http 命令能被正确剥出并分类，
// 多行反引号 heredoc 能完整提取，无反引号时行为与原逻辑保持不变。

import { describe, it, expect } from "vitest";

import {
  classifyCheckMethod,
  unwrapBacktickedCommand,
  type ParsedCheck,
} from "../../src/delivery/deliveryVerifier.js";

describe("Bug 5 / classifyCheckMethod 自然语言包裹解包（确定性示例）", () => {
  it("`运行 \\`test -f README.md\\` 并检查退出码为 0。` → shell，command 为裸命令", () => {
    const parsed = classifyCheckMethod("运行 `test -f README.md` 并检查退出码为 0。");
    expect(parsed.kind).toBe("shell");
    if (parsed.kind === "shell") {
      expect(parsed.command).toBe("test -f README.md");
    }
  });

  it("NL 包裹的 grep && 组合命令 → shell，反引号内 `|`/`&&` 完整保留", () => {
    const raw =
      "运行 `grep -Ei 'Node.*字符串工具|字符串工具.*Node|Node string utility|string utility.*Node' README.md && grep -F 'slugify' README.md && grep -F 'truncate' README.md` 并检查退出码为 0。";
    const parsed = classifyCheckMethod(raw);
    expect(parsed.kind).toBe("shell");
    if (parsed.kind === "shell") {
      expect(parsed.command).toBe(
        "grep -Ei 'Node.*字符串工具|字符串工具.*Node|Node string utility|string utility.*Node' README.md && grep -F 'slugify' README.md && grep -F 'truncate' README.md",
      );
      // 反引号内的 `|` 与 `&&` 必须原样保留（既不被散文吞掉，也不被提前切分）。
      expect(parsed.command).toContain("|");
      expect(parsed.command).toContain("&&");
    }
  });

  it("NL 包裹的多行反引号 heredoc（python）→ shell，整段脚本完整提取（含换行）", () => {
    const script = [
      "python3 - <<'PY'",
      "import sys",
      "data = open('README.md', encoding='utf-8').read()",
      "ok = ('slugify' in data) and ('truncate' in data)",
      "sys.exit(0 if ok else 1)",
      "PY",
    ].join("\n");
    const raw = `运行 \`${script}\` 并检查退出码为 0。`;
    const parsed = classifyCheckMethod(raw);
    expect(parsed.kind).toBe("shell");
    if (parsed.kind === "shell") {
      expect(parsed.command).toBe(script);
      // 多行结构（heredoc 起止标记与中间脚本行）完整保留。
      expect(parsed.command).toContain("<<'PY'");
      expect(parsed.command).toContain("sys.exit(0 if ok else 1)");
      expect(parsed.command.split("\n").length).toBe(6);
    }
  });

  it("NL 包裹的 HTTP 命令 → http（解包后仍能识别为 http 检验）", () => {
    // 注意：状态码 200 在反引号**外层散文**里，解包后仅对 `GET https://example.com` 分类，
    // 故 expectedStatus 缺省（任意 2xx 通过）——这是解包"只取反引号内命令"的正确结果。
    const parsed = classifyCheckMethod("运行 `GET https://example.com` 并检查响应码为 200。");
    expect(parsed.kind).toBe("http");
    if (parsed.kind === "http") {
      expect(parsed.method).toBe("GET");
      expect(parsed.url).toBe("https://example.com");
      expect(parsed.expectedStatus).toBeUndefined();
    }
  });

  it("反引号内含状态码标注时，expectedStatus 被正确解析", () => {
    const parsed = classifyCheckMethod("运行 `GET https://example.com => 200` 检查。");
    expect(parsed.kind).toBe("http");
    if (parsed.kind === "http") {
      expect(parsed.method).toBe("GET");
      expect(parsed.url).toBe("https://example.com");
      expect(parsed.expectedStatus).toBe(200);
    }
  });

  it("反引号内裸 http(s) URL（无方法）→ http，方法缺省为 GET", () => {
    const parsed = classifyCheckMethod("访问 `https://example.com/health` 检查可达。");
    expect(parsed.kind).toBe("http");
    if (parsed.kind === "http") {
      expect(parsed.method).toBe("GET");
      expect(parsed.url).toBe("https://example.com/health");
    }
  });

  it("无反引号时行为不变：原始整串按原逻辑分类（shell）", () => {
    const parsed = classifyCheckMethod("test -f README.md");
    expect(parsed.kind).toBe("shell");
    if (parsed.kind === "shell") {
      expect(parsed.command).toBe("test -f README.md");
    }
  });

  it("无反引号时行为不变：file: 前缀仍走文件断言", () => {
    const parsed = classifyCheckMethod("file:README.md exists");
    expect(parsed.kind).toBe("file");
    if (parsed.kind === "file") {
      expect(parsed.target).toBe("README.md");
      expect(parsed.assertion.mode).toBe("exists");
    }
  });

  it("无反引号时行为不变：裸 http URL 仍走 http 分类", () => {
    const parsed = classifyCheckMethod("GET https://example.com => 204");
    expect(parsed.kind).toBe("http");
    if (parsed.kind === "http") {
      expect(parsed.url).toBe("https://example.com");
      expect(parsed.expectedStatus).toBe(204);
    }
  });

  it("空串 / 仅空白 → shell 空命令（退化为执行期判 failed），不抛异常", () => {
    const a: ParsedCheck = classifyCheckMethod("");
    const b: ParsedCheck = classifyCheckMethod("   ");
    expect(a.kind).toBe("shell");
    expect(b.kind).toBe("shell");
    if (a.kind === "shell") expect(a.command).toBe("");
    if (b.kind === "shell") expect(b.command).toBe("");
  });

  it("空反引号 `` ``（内容为空）→ 不解包，退化为对原始整串分类", () => {
    expect(unwrapBacktickedCommand("运行 `` 并检查。")).toBeNull();
    // 原始串无可执行命令 → 退化为 shell（命令即整串 trim 后内容）。
    const parsed = classifyCheckMethod("运行 `` 并检查退出码为 0。");
    expect(parsed.kind).toBe("shell");
  });

  it("unwrapBacktickedCommand 纯函数：有反引号取首段内容，无反引号返回 null", () => {
    expect(unwrapBacktickedCommand("运行 `test -f x` 并检查。")).toBe("test -f x");
    expect(unwrapBacktickedCommand("没有反引号的普通串")).toBeNull();
    // 多段反引号：只取首段。
    expect(unwrapBacktickedCommand("先 `cmd-a` 再 `cmd-b`")).toBe("cmd-a");
  });
});
