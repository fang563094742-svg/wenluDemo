/**
 * proactive-awareness-demo —— Improvement 1 第 1 层单测：工具运行时噪音排除。
 *
 * 断言：工具点目录 / 噪音扩展名 / 噪音文件名（rollout、备份、hash blob、调试日志轮转、
 * .DS_Store 等）全部 `isExcluded === true`；同时真实用户文件不被误杀（false）。
 */

import { describe, it, expect } from "vitest";
import { isExcluded } from "../../src/scanner/exclusionPolicy.js";
import type { FileMeta } from "../../src/scanner/types.js";

function metaFor(path: string, overrides: Partial<FileMeta> = {}): FileMeta {
  const name = path.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  return {
    name,
    path,
    mtime: "2026-06-01T00:00:00.000Z",
    sizeBytes: 1,
    ext,
    ...overrides,
  };
}

describe("工具运行时噪音排除（机器产物绝不进 Scan_Summary）", () => {
  const noisePaths: { label: string; path: string }[] = [
    { label: "npm 调试日志（.npm/_logs）", path: "/Users/u/.npm/_logs/2026-06-01-debug-0.log" },
    {
      label: "codex rollout 会话记录",
      path: "/Users/u/.codex/sessions/rollout-2026-06-01T10-00-00-abc.jsonl",
    },
    {
      label: "jsonl 会话备份",
      path: "/Users/u/work/foo.jsonl.bak-1490-178293847",
    },
    { label: "agent 轨迹文件", path: "/Users/u/proj/x.trajectory.jsonl" },
    { label: "数据库 WAL", path: "/Users/u/proj/runs.sqlite-wal" },
    { label: "数据库 SHM", path: "/Users/u/proj/runs.db-shm" },
    { label: ".DS_Store", path: "/Users/u/Documents/.DS_Store" },
    {
      label: "长 hash blob",
      path: "/Users/u/.cache/blobs/a1b2c3d4e5f60718293a4b5c6d7e8f90",
    },
    { label: "调试日志轮转 -debug-0.log", path: "/Users/u/logs/server-debug-0.log" },
    { label: "日志轮转 .log.1", path: "/Users/u/logs/app.log.1" },
    { label: "通用备份 .bak", path: "/Users/u/notes/draft.txt.bak" },
    { label: "锁文件", path: "/Users/u/proj/package.lock" },
    { label: "依赖目录 node_modules", path: "/Users/u/proj/node_modules/lodash/index.js" },
    { label: "python 缓存目录", path: "/Users/u/proj/__pycache__/mod.cpython-311.pyc" },
    { label: "venv 目录", path: "/Users/u/proj/venv/lib/site.py" },
    { label: ".gradle 缓存目录", path: "/Users/u/.gradle/caches/jars/x.jar" },
  ];

  for (const { label, path } of noisePaths) {
    it(`排除：${label}`, () => {
      expect(isExcluded(path, metaFor(path))).toBe(true);
    });
  }

  const userPaths: { label: string; path: string }[] = [
    { label: "工作报告 report.md", path: "/Users/u/work/report.md" },
    { label: "源代码 index.ts", path: "/Users/u/projects/app/src/index.ts" },
    { label: "笔记 notes.txt", path: "/Users/u/Documents/notes.txt" },
    { label: "演示文稿 deck.pptx", path: "/Users/u/Desktop/deck.pptx" },
    { label: "数据 data.csv", path: "/Users/u/work/data.csv" },
    { label: "python 脚本 main.py", path: "/Users/u/projects/ml/main.py" },
  ];

  for (const { label, path } of userPaths) {
    it(`不误杀：${label}`, () => {
      expect(isExcluded(path, metaFor(path))).toBe(false);
    });
  }
});
