/**
 * 代理感知 fetch · 单元测试（纯逻辑，不打真实网络）
 */
import { describe, it, expect } from "vitest";
import { buildProxyFetch } from "./proxyFetch.js";

describe("buildProxyFetch · 让大脑走境外出口", () => {
  it("无代理 → 返回全局 fetch（零行为改变）", () => {
    expect(buildProxyFetch(undefined)).toBe(globalThis.fetch);
    expect(buildProxyFetch("")).toBe(globalThis.fetch);
    expect(buildProxyFetch("   ")).toBe(globalThis.fetch);
  });

  it("配了代理 → 返回不同于全局 fetch 的包装函数", () => {
    const f = buildProxyFetch("http://127.0.0.1:10808");
    expect(typeof f).toBe("function");
    expect(f).not.toBe(globalThis.fetch);
  });

  it("socks5:// → 原生 SOCKS 隧道（undici custom-connect），返回包装函数", () => {
    const f = buildProxyFetch("socks5://127.0.0.1:10808");
    expect(typeof f).toBe("function");
    expect(f).not.toBe(globalThis.fetch);
  });

  it("非法代理地址 → 安全回退全局 fetch，绝不让大脑因配置错误瘫痪", () => {
    const f = buildProxyFetch("not a valid url ::::");
    expect(f).toBe(globalThis.fetch);
  });
});
