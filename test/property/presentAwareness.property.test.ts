// Feature: proactive-awareness-demo, Property 5: For any Awareness_Item 集合，当集合非空时 PresenterView 渲染每一条（含"我检测到你最近在做 X…"标题文案与接受入口）且不显示"未察觉到可执行事项"提示；当集合为空时显示空提示且不渲染任何 item。两种呈现互斥。

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import type { Awareness_Item } from "../../src/analyzer/analyzer.js";
import {
  presentAwareness,
  buildPresentPrompt,
  EMPTY_AWARENESS_MESSAGE,
  ACCEPT_ENDPOINT,
  ACCEPT_LABEL,
} from "../../src/analyzer/presenter.js";

/**
 * Property 5: 察觉呈现的互斥不变量
 *
 * Validates: Requirements 7.1, 7.2, 7.4
 *
 * 不变量：
 *  - 非空集合 → ItemsView：逐条渲染（含"我检测到你最近在做 X…"标题文案与接受入口），
 *    且绝不显示"未察觉到可执行事项"空提示（emptyMessage 恒为 null）。
 *  - 空集合 → EmptyView：仅显示空提示，且不渲染任何 item。
 *  - 两种呈现互斥：任一输出要么 kind="items"（无空提示），要么 kind="empty"（无条目），
 *    不可兼有。
 */

/** 生成单条 Awareness_Item（字段任意，evidence 至少一条以贴近 Analyzer 真实输出）。 */
const awarenessItemArb: fc.Arbitrary<Awareness_Item> = fc.record({
  id: fc.string(),
  title: fc.string(),
  rationale: fc.string(),
  evidence: fc.array(fc.string(), { minLength: 1 }),
});

describe("Property 5: 察觉呈现的互斥不变量", () => {
  it("非空集合 → 逐条渲染 + 接受入口，且绝不出现空提示（R7.1/R7.2/R7.4）", () => {
    fc.assert(
      fc.property(
        fc.array(awarenessItemArb, { minLength: 1 }),
        (items) => {
          const view = presentAwareness(items);

          // 互斥分支：非空必为 items 视图
          expect(view.kind).toBe("items");
          if (view.kind !== "items") return;

          // 不显示空提示（emptyMessage 恒为 null，R7.4）
          expect(view.emptyMessage).toBeNull();

          // 与输入一一对应、同序
          expect(view.items).toHaveLength(items.length);

          view.items.forEach((rendered, i) => {
            const src = items[i]!;
            // 标题文案"我检测到你最近在做 X…"（R7.1）
            expect(rendered.prompt).toBe(buildPresentPrompt(src));
            expect(rendered.prompt).toContain("我检测到你最近在做");
            expect(rendered.prompt).toContain(src.title);
            // id 与原条目一致，便于接受动作引用
            expect(rendered.id).toBe(src.id);
            // 接受入口（R7.2）
            expect(rendered.acceptAction.label).toBe(ACCEPT_LABEL);
            expect(rendered.acceptAction.endpoint).toBe(ACCEPT_ENDPOINT);
            expect(rendered.acceptAction.itemId).toBe(src.id);
            // 绝不在任一条目里出现空提示文案（R7.4）
            expect(rendered.prompt).not.toContain(EMPTY_AWARENESS_MESSAGE);
          });
        },
      ),
      { numRuns: 100 },
    );
  });

  it("空集合 → 仅显示空提示，且不渲染任何 item（R7.3/R7.4）", () => {
    const view = presentAwareness([]);
    expect(view.kind).toBe("empty");
    if (view.kind !== "empty") return;
    expect(view.items).toHaveLength(0);
    expect(view.emptyMessage).toBe(EMPTY_AWARENESS_MESSAGE);
  });

  it("两种呈现互斥：恰好满足其一（含条目↔无空提示 / 有空提示↔无条目）", () => {
    fc.assert(
      fc.property(fc.array(awarenessItemArb), (items) => {
        const view = presentAwareness(items);

        const isItems = view.kind === "items";
        const isEmpty = view.kind === "empty";
        // 互斥且穷尽：恰好一个分支成立
        expect(isItems !== isEmpty).toBe(true);

        if (items.length === 0) {
          // 空输入：只能是空视图（有空提示、无条目）
          expect(isEmpty).toBe(true);
          if (view.kind === "empty") {
            expect(view.items).toHaveLength(0);
            expect(view.emptyMessage).toBe(EMPTY_AWARENESS_MESSAGE);
          }
        } else {
          // 非空输入：只能是条目视图（有条目、无空提示）
          expect(isItems).toBe(true);
          if (view.kind === "items") {
            expect(view.items.length).toBeGreaterThan(0);
            expect(view.emptyMessage).toBeNull();
          }
        }
      }),
      { numRuns: 100 },
    );
  });
});
