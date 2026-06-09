// Feature: proactive-awareness-demo, Bug 5 property: *For any* 不含反引号的自然语言前/后缀散文，与一段不含反引号、去空白后非空的内层命令 inner，把 inner 用反引号包裹并嵌入散文得到 raw，则 `classifyCheckMethod(raw)` 的解析结果**等价于**直接 `classifyCheckMethod(inner)`——即解包是"提取首段反引号内命令再按原逻辑分类"的纯确定性变换，散文包裹不影响分类与提取的命令体。
//
// **Validates: Requirements 15.1, 12.5**
//
// 被测纯函数：`src/delivery/deliveryVerifier.ts` 的 `classifyCheckMethod` / `unwrapBacktickedCommand`。
// 通过"等价性 oracle"（包裹后分类 ≡ 直接分类内层）回避同义反复，覆盖 shell / http 两类内层命令、
// 含 `|`/`&&` 的组合命令、多行 heredoc，以及任意散文前后缀（不含反引号）。

import { describe, it, expect } from "vitest";
import fc from "fast-check";

import {
  classifyCheckMethod,
  unwrapBacktickedCommand,
} from "../../src/delivery/deliveryVerifier.js";

// ---------------------------------------------------------------------------
// 生成器
// ---------------------------------------------------------------------------

/** 不含反引号的散文片段（中英文 + 常见标点/空白），可空。用于前后缀包裹。 */
const proseArb = fc
  .stringOf(fc.constantFrom(..."运行执行检查退出码为并请确保Run command 0.：。, ".split("")), {
    maxLength: 12,
  })
  .filter((s) => !s.includes("`"));

/** shell 内层命令：首 token 取自常见命令，跟随不含反引号的参数（可含引号内的 |/&&）。 */
const shellInnerArb = fc
  .tuple(
    fc.constantFrom("test -f README.md", "ls -la", "grep -F 'slugify' README.md", "node app.js"),
    fc.constantFrom(
      "",
      " && grep -F 'truncate' README.md",
      " | sort",
      " && echo 'A|B|C'",
    ),
  )
  .map(([head, tail]) => head + tail);

/** 多行 heredoc 内层命令（确保跨行提取正确）。 */
const heredocInnerArb = fc.constant(
  ["python3 - <<'PY'", "import sys", "sys.exit(0)", "PY"].join("\n"),
);

/** http 内层命令：可选方法 + https URL（可选状态码标注）。 */
const httpInnerArb = fc
  .tuple(
    fc.constantFrom("", "GET ", "POST ", "HEAD "),
    fc.constantFrom("https://example.com", "https://example.com/health", "http://localhost:3000/x"),
    fc.constantFrom("", " => 200", " => 204"),
  )
  .map(([m, url, st]) => `${m}${url}${st}`);

/** file: 内层断言（验证解包后仍走文件断言分支）。 */
const fileInnerArb = fc.constantFrom(
  "file:README.md exists",
  "file:src/index.ts contains slugify",
);

/** 内层命令（去空白后保证非空，故解包必返回内容）。 */
const innerArb = fc
  .oneof(shellInnerArb, heredocInnerArb, httpInnerArb, fileInnerArb)
  .filter((s) => s.trim().length > 0 && !s.includes("`"));

// ---------------------------------------------------------------------------
// Property
// ---------------------------------------------------------------------------

describe("Bug 5 property: 自然语言包裹解包等价于直接分类内层命令", () => {
  it("classifyCheckMethod(prefix + `inner` + suffix) ≡ classifyCheckMethod(inner)", () => {
    fc.assert(
      fc.property(proseArb, innerArb, proseArb, (prefix, inner, suffix) => {
        const raw = `${prefix}\`${inner}\`${suffix}`;

        // 解包：首段反引号内的内容（去空白）应恰为 inner.trim()。
        expect(unwrapBacktickedCommand(raw)).toBe(inner.trim());

        // 等价性：包裹后分类 ≡ 直接分类内层（散文与反引号不影响分类与提取的命令体）。
        const wrapped = classifyCheckMethod(raw);
        const direct = classifyCheckMethod(inner);
        expect(wrapped).toEqual(direct);
      }),
      { numRuns: 100 },
    );
  });
});
