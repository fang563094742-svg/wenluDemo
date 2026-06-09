// Feature: proactive-awareness-demo, Property 16: 完成判定要求真实且与目标相关的落地。For any 执行循环历史与任务 `primaryTargets`，`hasMaterializedRelevantActions(log, primaryTargets)` 返回 true 当且仅当历史中存在至少一个真实落地动作（写文件 / 跑命令等 materialized 动作）且当 primaryTargets 非空时至少一个落地动作触及 primaryTargets 之一；当不存在触及 primaryTargets 的落地动作时（即便存在其他无关落地动作、或 LLM 返回了 finalText），该函数为 false，循环不将任务判定为 completed；当 primaryTargets 为空时退化为"只要存在任一真实落地动作即为 true"。

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { hasMaterializedRelevantActions } from "../../src/executor/completion.js";
import type { ToolInvocation } from "../../src/executor/types.js";

/**
 * Property 16: 完成判定要求真实且与目标相关的落地（安全关键）
 *
 * Validates: Requirements 12.5
 *
 * 充要条件：`hasMaterializedRelevantActions(log, primaryTargets) === true` 当且仅当
 *  - 存在至少一个**真实落地动作**（工具属于 {write_file, run_command, delete_file}、
 *    `result.ok === true`、且未被安全门拦截 `blocked !== true`）；且
 *  - 当 `primaryTargets` 非空时，至少一个真实落地动作的参数触及某个 target；
 *  - 当 `primaryTargets` 为空时退化为「只要有任一真实落地动作即可」。
 * 其余情况（无任何真实落地动作 / 仅有无关落地动作）均为 false。
 */

/** 与被测实现保持一致的「真实落地」工具集合，供独立参考判定使用。 */
const MATERIALIZING_TOOLS = new Set<string>([
  "write_file",
  "run_command",
  "delete_file",
]);
/** 只读 / 非落地工具：恒不计入真实落地动作。 */
const NON_MATERIALIZING_TOOLS = ["read_file", "list_dir"] as const;

// ── 智能生成器：把输入空间约束到可判别的「触及 / 不触及目标」两类 ──────────────

/**
 * 目标 token：恒以 `TGT_` 前缀 + 十六进制（0-9a-f）尾巴构成，非空且彼此风格统一。
 * 关键：`TGT_` 含大写字母，绝不会被下方 noise（仅小写 hex + `noise_`）误含为子串。
 */
const targetArb: fc.Arbitrary<string> = fc
  .hexaString({ minLength: 1, maxLength: 8 })
  .map((s) => "TGT_" + s);

/**
 * 噪声字符串：`noise_` + 十六进制，保证**永不包含** `TGT_` 序列，
 * 因此用作参数时一定「不触及」任何 target。
 */
const noiseArb: fc.Arbitrary<string> = fc
  .hexaString({ maxLength: 12 })
  .map((s) => "noise_" + s);

/** 把若干 target 之一嵌入噪声中间，得到「确实触及目标」的参数字符串。 */
const relevantStrArb = (targets: string[]): fc.Arbitrary<string> =>
  fc
    .tuple(noiseArb, fc.constantFrom(...targets), noiseArb)
    .map(([a, t, b]) => a + t + b);

/** 把字符串包成 {path} / {command} / 无关键名 的参数对象。 */
const argsWith = (strArb: fc.Arbitrary<string>): fc.Arbitrary<Record<string, unknown>> =>
  fc.oneof(
    strArb.map((s) => ({ path: s })),
    strArb.map((s) => ({ command: s })),
    strArb.map((s) => ({ note: s })),
  );

interface InvParts {
  name: string;
  ok: boolean;
  blocked: boolean;
  args: Record<string, unknown>;
}

const mkInv = ({ name, ok, blocked, args }: InvParts): ToolInvocation => ({
  tc: { name, arguments: args },
  result: { ok, output: ok ? "done" : "err", ...(ok ? {} : { error: "boom" }) },
  blocked,
});

/** 一个「触及目标的真实落地动作」（materializing tool + ok + 未拦截 + 参数含 target）。 */
const relevantMaterializedArb = (targets: string[]): fc.Arbitrary<ToolInvocation> =>
  fc
    .record({
      name: fc.constantFrom("write_file", "run_command", "delete_file"),
      args: argsWith(relevantStrArb(targets)),
    })
    .map(({ name, args }) => mkInv({ name, ok: true, blocked: false, args }));

/** 一个「无关的真实落地动作」（materializing tool + ok + 未拦截 + 参数为噪声，不含任何 target）。 */
const irrelevantMaterializedArb: fc.Arbitrary<ToolInvocation> = fc
  .record({
    name: fc.constantFrom("write_file", "run_command", "delete_file"),
    args: argsWith(noiseArb),
  })
  .map(({ name, args }) => mkInv({ name, ok: true, blocked: false, args }));

/**
 * 一个「非真实落地动作」：通过以下任一方式保证被实现的 materialized 过滤剔除：
 *  - 只读/非落地工具名；或
 *  - 落地工具但 `ok === false`；或
 *  - 落地工具但 `blocked === true`。
 */
const nonMaterializedArb: fc.Arbitrary<ToolInvocation> = fc.oneof(
  // 非落地工具名（ok/blocked 任意）
  fc
    .record({
      name: fc.constantFrom(...NON_MATERIALIZING_TOOLS),
      ok: fc.boolean(),
      blocked: fc.boolean(),
      args: argsWith(fc.oneof(noiseArb, targetArb)),
    })
    .map(mkInv),
  // 落地工具但执行失败
  fc
    .record({
      name: fc.constantFrom("write_file", "run_command", "delete_file"),
      blocked: fc.boolean(),
      args: argsWith(fc.oneof(noiseArb, targetArb)),
    })
    .map(({ name, blocked, args }) => mkInv({ name, ok: false, blocked, args })),
  // 落地工具但被安全门拦截
  fc
    .record({
      name: fc.constantFrom("write_file", "run_command", "delete_file"),
      args: argsWith(fc.oneof(noiseArb, targetArb)),
    })
    .map(({ name, args }) => mkInv({ name, ok: true, blocked: true, args })),
);

// ── 独立参考判定（与实现逻辑独立书写，作为充要条件的金标准）──────────────────
function refExpected(
  log: ToolInvocation[],
  primaryTargets: string[] | undefined,
): boolean {
  const materialized = log.filter(
    (inv) =>
      MATERIALIZING_TOOLS.has(inv.tc.name) && inv.result.ok && inv.blocked !== true,
  );
  if (materialized.length === 0) return false;
  if (!primaryTargets || primaryTargets.length === 0) return true;
  return materialized.some((inv) => {
    const blob = JSON.stringify(inv.tc.arguments ?? {});
    return primaryTargets.some((t) => blob.includes(t));
  });
}

/** 任意混合 log：四类动作打散组合，覆盖整个输入空间。 */
const mixedLogArb = (targets: string[]): fc.Arbitrary<ToolInvocation[]> =>
  fc.array(
    targets.length > 0
      ? fc.oneof(
          relevantMaterializedArb(targets),
          irrelevantMaterializedArb,
          nonMaterializedArb,
        )
      : fc.oneof(irrelevantMaterializedArb, nonMaterializedArb),
    { maxLength: 12 },
  );

/** 仅生成「非真实落地」动作的 log（保证不存在任何 materialized 动作）。 */
const nonMaterializedLogArb: fc.Arbitrary<ToolInvocation[]> = fc.array(
  nonMaterializedArb,
  { maxLength: 12 },
);

/** 把若干数组随机打散（保留各元素、交错顺序）。 */
const shuffle = <T>(arr: T[]): fc.Arbitrary<T[]> =>
  fc.constant(arr).chain((a) =>
    a.length <= 1 ? fc.constant(a) : (fc.shuffledSubarray(a, { minLength: a.length, maxLength: a.length }) as fc.Arbitrary<T[]>),
  );

describe("Property 16: 完成判定要求真实且与目标相关的落地", () => {
  it("充要条件：结果恒等于独立参考判定（任意目标 × 任意混合 log）", () => {
    fc.assert(
      fc.property(
        fc.array(targetArb, { maxLength: 4 }).chain((targets) =>
          mixedLogArb(targets).map((log) => ({ targets, log })),
        ),
        ({ targets, log }) => {
          expect(hasMaterializedRelevantActions(log, targets)).toBe(
            refExpected(log, targets),
          );
        },
      ),
      { numRuns: 100 },
    );
  });

  it("无任何真实落地动作 → 恒为 false（无论 targets 是否非空）", () => {
    fc.assert(
      fc.property(
        nonMaterializedLogArb,
        fc.array(targetArb, { maxLength: 4 }),
        (log, targets) => {
          expect(hasMaterializedRelevantActions(log, targets)).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("primaryTargets 为空/undefined + 至少一个真实落地动作 → true（退化情形）", () => {
    fc.assert(
      fc.property(
        fc
          .tuple(
            irrelevantMaterializedArb,
            nonMaterializedLogArb,
            fc.constantFrom<string[] | undefined>([], undefined),
          )
          .chain(([materialized, noise, targets]) =>
            shuffle([materialized, ...noise]).map((log) => ({ log, targets })),
          ),
        ({ log, targets }) => {
          expect(hasMaterializedRelevantActions(log, targets)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("primaryTargets 非空 + 至少一个落地动作触及目标 → true（即便混入无关动作）", () => {
    fc.assert(
      fc.property(
        fc
          .array(targetArb, { minLength: 1, maxLength: 4 })
          .chain((targets) =>
            fc
              .tuple(
                relevantMaterializedArb(targets),
                fc.array(
                  fc.oneof(irrelevantMaterializedArb, nonMaterializedArb),
                  { maxLength: 10 },
                ),
              )
              .chain(([relevant, rest]) =>
                shuffle([relevant, ...rest]).map((log) => ({ log, targets })),
              ),
          ),
        ({ log, targets }) => {
          expect(hasMaterializedRelevantActions(log, targets)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("primaryTargets 非空 + 仅有无关落地动作（无一触及目标）→ false（防无关假动作）", () => {
    fc.assert(
      fc.property(
        fc
          .array(targetArb, { minLength: 1, maxLength: 4 })
          .chain((targets) =>
            fc
              .tuple(
                // 至少一个无关落地动作，确保走到「相关性」判定分支
                fc.array(irrelevantMaterializedArb, { minLength: 1, maxLength: 6 }),
                fc.array(nonMaterializedArb, { maxLength: 6 }),
              )
              .chain(([irr, noise]) =>
                shuffle([...irr, ...noise]).map((log) => ({ log, targets })),
              ),
          ),
        ({ log, targets }) => {
          expect(hasMaterializedRelevantActions(log, targets)).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });
});
