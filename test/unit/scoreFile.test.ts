/**
 * proactive-awareness-demo —— Improvement 1 第 2 层单测：打分纯函数与系统 App 过滤。
 *
 * 断言：
 *  - 用户内容类型文件分 > 同等 recency 的非内容文件（内容类型加权生效）；
 *  - 聚类权重降低后，大量同目录噪音文件不再单凭聚类超过一个高 recency 的内容文件；
 *  - isSystemApp：Finder/System Settings 等 → true；用户 App → false。
 */

import { describe, it, expect } from "vitest";
import { scoreFile, isSystemApp } from "../../src/scanner/macScanner.js";
import type { FileMeta } from "../../src/scanner/types.js";

function fileMeta(ext: string): FileMeta {
  return {
    name: `f.${ext}`,
    path: `/Users/u/x/f.${ext}`,
    mtime: "2026-06-01T00:00:00.000Z",
    sizeBytes: 1,
    ext,
  };
}

describe("scoreFile（内容类型加权 + 聚类权重降低）", () => {
  it("同等 recency / cluster 下，用户内容类型文件分 > 非内容文件", () => {
    const recency = 0.5;
    const cluster = 0.2;
    const contentScore = scoreFile(fileMeta("md"), recency, cluster);
    const nonContentScore = scoreFile(fileMeta("dat"), recency, cluster);
    expect(contentScore).toBeGreaterThan(nonContentScore);
  });

  it("代码扩展名同样获得内容加权", () => {
    const code = scoreFile(fileMeta("ts"), 0.3, 0);
    const other = scoreFile(fileMeta("bin"), 0.3, 0);
    expect(code).toBeGreaterThan(other);
  });

  it("聚类权重降低后：满聚类的非内容噪音文件，分数仍低于高 recency 的内容文件", () => {
    // 噪音文件：recency 较低但同目录堆满（clusterFactor=1）。
    const noisy = scoreFile(fileMeta("dat"), 0.1, 1);
    // 用户内容文件：高 recency，独处一目录（clusterFactor=0）。
    const content = scoreFile(fileMeta("md"), 0.9, 0);
    expect(content).toBeGreaterThan(noisy);
  });
});

describe("isSystemApp（系统常驻 App 过滤）", () => {
  for (const sys of [
    "Finder",
    "Dock",
    "System Settings",
    "SystemUIServer",
    "ControlCenter",
    "Notification Center",
    "Spotlight",
    "Siri",
  ]) {
    it(`系统 App → true：${sys}`, () => {
      expect(isSystemApp(sys)).toBe(true);
    });
  }

  for (const userApp of ["Code", "Xcode", "Google Chrome", "Terminal", "iTerm2"]) {
    it(`用户 App → false：${userApp}`, () => {
      expect(isSystemApp(userApp)).toBe(false);
    });
  }

  it("大小写不敏感：FINDER → true", () => {
    expect(isSystemApp("FINDER")).toBe(true);
  });
});
