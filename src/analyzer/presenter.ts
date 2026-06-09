/**
 * proactive-awareness-demo —— 察觉呈现层 Awareness_Presenter（任务 6.3）。
 *
 * 设计依据：design.md「分析层（R5-R7）→ Awareness_Presenter（R7）」与
 * 「Correctness Properties → Property 5: 察觉呈现的互斥不变量」。
 *
 * 职责（纯函数，便于 Property 5 测试）：
 *  - 非空集合：逐条渲染「我检测到你最近在做 X，需要我帮你做吗？」文案 + 接受入口
 *    （R7.1/R7.2），且**绝不**显示「未察觉到可执行事项」空提示（R7.4）。
 *  - 空集合：仅显示空提示（R7.3），且**不渲染任何** item。
 *  - 两种呈现**互斥**：由 `PresenterView` 的可辨识联合（discriminated union）在类型层强制
 *    —— `ItemsView`（kind="items"）携带渲染条目且 `emptyMessage: null`；
 *       `EmptyView`（kind="empty"）携带 `emptyMessage` 且 `items: []`。
 *
 * 关键约束：
 *  - `present` 是**纯函数**：仅依据输入 `items` 计算 `PresenterView`，无副作用、确定性，
 *    以支撑 property-based test（任务 6.4 / Property 5）。
 *  - 不改变 `Awareness_Item` 的类型结构（复用 `analyzer.ts` 的权威定义）。
 *
 * _Requirements: 7.1, 7.2, 7.3, 7.4_
 */

import type { Awareness_Item } from "./analyzer.js";

// ===========================================================================
// 常量：呈现文案与接受入口
// ===========================================================================

/**
 * 空提示文案（R7.3）：未察觉到可执行事项时告知用户。
 * 仅在 `EmptyView` 中出现；`ItemsView` 中绝不出现（R7.4）。
 */
export const EMPTY_AWARENESS_MESSAGE = "本次未察觉到可执行的事项。";

/** 接受入口对应的 REST 端点（design.md「server/routes.ts → POST /accept」，R7.2）。 */
export const ACCEPT_ENDPOINT = "/accept";

/** 接受入口按钮文案。 */
export const ACCEPT_LABEL = "需要，帮我做";

/**
 * 由单条 Awareness_Item 构造「我检测到你最近在做 X，需要我帮你做吗？」呈现文案（R7.1）。
 * X 取自该条 `title`（推断出的任务 / 问题简述）。
 */
export function buildPresentPrompt(item: Awareness_Item): string {
  return `我检测到你最近在做 ${item.title}，需要我帮你做吗？`;
}

// ===========================================================================
// 呈现视图类型（可辨识联合 → 互斥不变量在类型层强制，R7.4）
// ===========================================================================

/** 供用户表达「接受」的交互入口（R7.2）。 */
export interface AcceptAction {
  /** 按钮文案。 */
  label: string;
  /** 触发接受的 REST 端点（`POST /accept`）。 */
  endpoint: string;
  /** 被接受的 Awareness_Item 标识，随请求回传给 Orchestrator。 */
  itemId: string;
}

/** 单条 Awareness_Item 的渲染结果：呈现文案 + 接受入口 + 原始条目。 */
export interface RenderedAwarenessItem {
  /** 与原始 `Awareness_Item.id` 一致，便于 UI / 接受动作引用。 */
  id: string;
  /** 「我检测到你最近在做 X，需要我帮你做吗？」呈现文案（R7.1）。 */
  prompt: string;
  /** 供用户表达接受的交互入口（R7.2）。 */
  acceptAction: AcceptAction;
  /** 原始 Awareness_Item（供 UI 展开 rationale / evidence 等细节）。 */
  item: Awareness_Item;
}

/** 非空呈现：渲染每一条，且**绝不**显示空提示（`emptyMessage` 恒为 null，R7.1/R7.2/R7.4）。 */
export interface ItemsView {
  kind: "items";
  /** 至少一条渲染条目（与输入 items 一一对应、同序）。 */
  items: RenderedAwarenessItem[];
  /** 互斥不变量：非空呈现时绝不出现空提示。 */
  emptyMessage: null;
}

/** 空呈现：仅显示空提示，且**不渲染任何** item（R7.3）。 */
export interface EmptyView {
  kind: "empty";
  /** 互斥不变量：空呈现时不渲染任何条目。 */
  items: readonly [];
  /** 空提示文案（R7.3）。 */
  emptyMessage: string;
}

/**
 * 察觉呈现视图：`ItemsView` 与 `EmptyView` 互斥（可辨识联合，R7.4）。
 * 任一实例要么渲染条目（空提示为 null），要么显示空提示（条目为空），不可兼有。
 */
export type PresenterView = ItemsView | EmptyView;

// ===========================================================================
// Awareness_Presenter 接口与实现
// ===========================================================================

/**
 * 察觉呈现器：把 Analyzer 产出的 `Awareness_Item[]` 转为可供 UI 渲染的 `PresenterView`。
 */
export interface Awareness_Presenter {
  /**
   * 纯函数：依据 `items` 是否为空，产出互斥的 `ItemsView` / `EmptyView`。
   *  - 非空：每条渲染「我检测到你最近在做 X…」+ 接受入口，无空提示（R7.1/R7.2/R7.4）。
   *  - 空：仅空提示，无任何渲染条目（R7.3）。
   */
  present(items: Awareness_Item[]): PresenterView;
}

/**
 * `Awareness_Presenter` 的默认实现（无状态、纯函数）。
 */
export class DefaultAwarenessPresenter implements Awareness_Presenter {
  present(items: Awareness_Item[]): PresenterView {
    return presentAwareness(items);
  }
}

/**
 * 纯函数式呈现：供接口实现与 property test（任务 6.4 / Property 5）直接调用。
 *
 * 互斥分支：
 *  - `items.length > 0` → `ItemsView`：逐条渲染、`emptyMessage: null`。
 *  - `items.length === 0` → `EmptyView`：空提示、无渲染条目。
 */
export function presentAwareness(items: Awareness_Item[]): PresenterView {
  if (items.length === 0) {
    return {
      kind: "empty",
      items: [],
      emptyMessage: EMPTY_AWARENESS_MESSAGE,
    };
  }

  return {
    kind: "items",
    items: items.map(renderItem),
    emptyMessage: null,
  };
}

/** 把单条 `Awareness_Item` 渲染为带呈现文案与接受入口的 `RenderedAwarenessItem`。 */
function renderItem(item: Awareness_Item): RenderedAwarenessItem {
  return {
    id: item.id,
    prompt: buildPresentPrompt(item),
    acceptAction: {
      label: ACCEPT_LABEL,
      endpoint: ACCEPT_ENDPOINT,
      itemId: item.id,
    },
    item,
  };
}
