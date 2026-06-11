/**
 * flywheel-config 属性测试 — P9 向后兼容（最高约束·不可跳过）
 * Validates: Requirements 7.1
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { DEFAULT_FLYWHEEL, resolveFlywheelConfig } from "../flywheel-config.js";

describe("P9 配置向后兼容 + 缺省零改变", () => {
  it("mind 无 skillFlywheel ⟹ 深度等于默认", () => {
    fc.assert(
      fc.property(fc.option(fc.constant({}), { nil: undefined }), (mind) => {
        const cfg = resolveFlywheelConfig(mind as { skillFlywheel?: never } | undefined);
        expect(cfg).toEqual(DEFAULT_FLYWHEEL);
        // 是深拷贝而非引用：改返回值不污染常量
        cfg.enabled.router = true;
        expect(DEFAULT_FLYWHEEL.enabled.router).toBe(false);
      }),
    );
  });

  it("缺省 mode=observe、全 enabled=false", () => {
    expect(DEFAULT_FLYWHEEL.mode).toBe("observe");
    expect(DEFAULT_FLYWHEEL.enabled.router).toBe(false);
    expect(DEFAULT_FLYWHEEL.enabled.distiller).toBe(false);
  });

  it("不修改入参", () => {
    fc.assert(
      fc.property(
        fc.record({
          mode: fc.constantFrom("observe" as const, "enforce" as const),
          router: fc.boolean(),
          distiller: fc.boolean(),
          minVerifyToTrust: fc.integer({ min: 0, max: 9 }),
        }),
        ({ mode, router, distiller, minVerifyToTrust }) => {
          const mind = { skillFlywheel: { mode, enabled: { router, distiller }, minVerifyToTrust } };
          const snapshot = JSON.stringify(mind);
          const cfg = resolveFlywheelConfig(mind);
          expect(JSON.stringify(mind)).toBe(snapshot);
          expect(cfg.mode).toBe(mode);
          expect(cfg.enabled.router).toBe(router);
          expect(cfg.minVerifyToTrust).toBe(minVerifyToTrust);
        },
      ),
    );
  });

  it("非法 minVerifyToTrust 回退默认", () => {
    const cfg = resolveFlywheelConfig({ skillFlywheel: { mode: "observe", enabled: { router: false, distiller: false }, minVerifyToTrust: NaN } });
    expect(cfg.minVerifyToTrust).toBe(DEFAULT_FLYWHEEL.minVerifyToTrust);
  });
});
