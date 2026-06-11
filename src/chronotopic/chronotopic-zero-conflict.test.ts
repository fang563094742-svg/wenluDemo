import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  brierScore,
  meanBrier,
  judgmentScore,
  clamp01,
  calibrationTable,
  worstOverconfidenceBin,
  type GradedPrediction,
} from "../judgment/calibration.js";
import { buildDomainJudgementPacket } from "../riverbed/index.js";

/**
 * 时空校准层 · 与既有模块零冲突契约测试（Task 7.2）
 *
 * 时空层 V1 全部新代码落在 `src/chronotopic/`，仅在 `riverMain.ts` 四处锚点最小侵入
 * 接入。本测试从**既有模块的公共导出**出发，断言时空层落地后既有模块的签名 / 语义
 * 完全未变：
 *   1. `judgment/calibration.ts` 既有导出函数仍可正常 import 且对固定输入回归一致
 *      （证明时空层没有改动 calibration.ts）。
 *   2. `DomainJudgementPacket` 字段集合未变（没有被时空层注入新字段）。
 *   3. `hippocampus/retrieval.ts` 的 `retrieveRelevant` 与 `riverbed/riverbed-store.ts`
 *      的 `getActiveRiverbedNodes` 函数签名字符串仍存在且未被时空层改动（静态 grep）。
 *
 * 绝对边界（本测试自身）：只 import vitest + node:fs / node:path / node:url +
 * 被测既有模块的公共导出。不改动任何非测试源码。
 *
 * _Requirements: 13.1, 13.5_
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(HERE, "..");

describe("时空层与既有模块零冲突契约 (Task 7.2)", () => {
  // ── 1. judgment/calibration.ts 既有导出签名 / 语义未变（回归断言） ──
  describe("judgment/calibration.ts 既有导出语义未被时空层改动 — Req 13.1", () => {
    it("brierScore：固定输入回归一致", () => {
      // 报 0.9 且命中 → (0.9-1)^2 = 0.01（极小）。
      expect(brierScore(0.9, true)).toBeCloseTo(0.01, 10);
      // 报 0.9 却落空 → (0.9-0)^2 = 0.81（剧痛）。
      expect(brierScore(0.9, false)).toBeCloseTo(0.81, 10);
      // 越界自动夹紧：1.5→1，命中 → 0。
      expect(brierScore(1.5, true)).toBeCloseTo(0, 10);
      // NaN → clamp01 归 0.5；落空 → 0.25。
      expect(brierScore(Number.NaN, false)).toBeCloseTo(0.25, 10);
    });

    it("clamp01：既有语义（NaN→0.5，越界夹紧）未变", () => {
      expect(clamp01(Number.NaN)).toBe(0.5);
      expect(clamp01(-1)).toBe(0);
      expect(clamp01(2)).toBe(1);
      expect(clamp01(0.42)).toBe(0.42);
    });

    it("meanBrier：空集返回 null，非空回归一致", () => {
      expect(meanBrier([])).toBeNull();
      const graded: GradedPrediction[] = [
        { confidence: 0.9, hit: true }, // 0.01
        { confidence: 0.9, hit: false }, // 0.81
      ];
      // (0.01 + 0.81) / 2 = 0.41
      expect(meanBrier(graded)).toBeCloseTo(0.41, 10);
    });

    it("judgmentScore：样本不足返回 null，达标集合回归一致", () => {
      // 默认 minSample = 3，样本不足返回 null。
      expect(judgmentScore([{ confidence: 0.8, hit: true }])).toBeNull();

      // 全命中且全报 1.0 → Brier=0 → 分数 100。
      const perfect: GradedPrediction[] = [
        { confidence: 1, hit: true },
        { confidence: 1, hit: true },
        { confidence: 1, hit: true },
      ];
      expect(judgmentScore(perfect)).toBe(100);

      // 已知集合：3 条 [0.9/true, 0.9/true, 0.9/false]
      // brier = [0.01, 0.01, 0.81]，mean = 0.83/3 ≈ 0.27667
      // score = round((1-0.27667)*100) = round(72.333) = 72
      const known: GradedPrediction[] = [
        { confidence: 0.9, hit: true },
        { confidence: 0.9, hit: true },
        { confidence: 0.9, hit: false },
      ];
      expect(judgmentScore(known)).toBe(72);
    });

    it("calibrationTable：分桶正确（区间 / count / 命中率 / bias）回归一致", () => {
      // 构造两个不同信心桶的可裁定预测。
      const graded: GradedPrediction[] = [
        // 0.05 桶（lo=0, hi=0.1）：两条，1 命中 → 命中率 0.5
        { confidence: 0.05, hit: true },
        { confidence: 0.05, hit: false },
        // 0.95 桶（lo=0.9, hi=1）：两条，全命中 → 命中率 1.0
        { confidence: 0.95, hit: true },
        { confidence: 0.95, hit: true },
      ];
      const bins = calibrationTable(graded);
      // 只返回有样本的桶：恰好 2 桶。
      expect(bins.length).toBe(2);

      const lowBin = bins.find((b) => b.lo === 0);
      expect(lowBin).toBeDefined();
      expect(lowBin!.hi).toBeCloseTo(0.1, 10);
      expect(lowBin!.count).toBe(2);
      expect(lowBin!.meanConfidence).toBeCloseTo(0.05, 3);
      expect(lowBin!.actualHitRate).toBeCloseTo(0.5, 3);
      expect(lowBin!.bias).toBeCloseTo(0.45, 3); // 0.5 - 0.05

      const highBin = bins.find((b) => b.lo === 0.9);
      expect(highBin).toBeDefined();
      expect(highBin!.hi).toBe(1); // 最后一桶含 1.0
      expect(highBin!.count).toBe(2);
      expect(highBin!.meanConfidence).toBeCloseTo(0.95, 3);
      expect(highBin!.actualHitRate).toBeCloseTo(1, 3);
      expect(highBin!.bias).toBeCloseTo(0.05, 3); // 1 - 0.95
    });

    it("worstOverconfidenceBin：系统性高估桶识别回归一致", () => {
      // 一桶高信心却低命中（系统性高估），桶内样本 ≥ 默认 minBinCount=3。
      const graded: GradedPrediction[] = [
        { confidence: 0.95, hit: false },
        { confidence: 0.95, hit: false },
        { confidence: 0.95, hit: true },
      ];
      const worst = worstOverconfidenceBin(graded);
      expect(worst).not.toBeNull();
      expect(worst!.lo).toBe(0.9);
      expect(worst!.bias).toBeLessThan(0); // 实际命中率 < 报出信心

      // 无显著高估（全部命中）→ 返回 null。
      const allHit: GradedPrediction[] = [
        { confidence: 0.95, hit: true },
        { confidence: 0.95, hit: true },
        { confidence: 0.95, hit: true },
      ];
      expect(worstOverconfidenceBin(allHit)).toBeNull();
    });
  });

  // ── 2. DomainJudgementPacket 字段集合未被时空层注入新字段 — Req 13.5 ──
  describe("DomainJudgementPacket 字段集合未变 — Req 13.5", () => {
    it("buildDomainJudgementPacket 构造的 packet 恰含既有字段集合，无时空层新字段", () => {
      const packet = buildDomainJudgementPacket({
        domain: "D1_IDENTITY",
        targetObjectType: "belief",
        targetObjectId: "belief-zero-conflict",
        targetSummary: "零冲突契约测试目标",
        judgementType: "alignment",
        score: 0.7,
        confidence: 0.8,
        severity: "low",
        verdict: "support",
        reason: "回归契约：字段集合应与既有一致",
        freshness: "fresh",
        constraintLevel: "ADVISORY",
        suggestedNextStep: null,
        recoveryRequired: false,
        createdAt: "2026-01-01T00:00:00.000Z",
      });

      // 既有字段集合（V1 时空层不得注入任何新字段，如 chronotopic / signatureId 等）。
      const expectedKeys = [
        "packetId",
        "domain",
        "targetObjectType",
        "targetObjectId",
        "targetSummary",
        "judgementType",
        "score",
        "confidence",
        "severity",
        "verdict",
        "reason",
        "freshness",
        "matchedNodeIds",
        "evidenceRefs",
        "constraintRefs",
        "constraintLevel",
        "suggestedNextStep",
        "suggestedCutList",
        "recoveryRequired",
        "createdAt",
      ].sort();

      expect(Object.keys(packet).sort()).toEqual(expectedKeys);

      // 显式断言没有任何时空层字段被注入到 packet。
      const packetForbidden = packet as unknown as Record<string, unknown>;
      expect(packetForbidden.chronotopic).toBeUndefined();
      expect(packetForbidden.signatureId).toBeUndefined();
      expect(packetForbidden.chronotopicSignature).toBeUndefined();
      expect(packetForbidden.presence).toBeUndefined();
      expect(packetForbidden.temporal).toBeUndefined();

      // 既有归一化语义仍生效（score/confidence ∈ [0,1]，缺省数组字段为 []）。
      expect(packet.score).toBe(0.7);
      expect(packet.confidence).toBe(0.8);
      expect(packet.matchedNodeIds).toEqual([]);
      expect(packet.evidenceRefs).toEqual([]);
      expect(packet.constraintRefs).toEqual([]);
      expect(packet.suggestedCutList).toEqual([]);
    });
  });

  // ── 3. 既有函数签名字符串未被时空层改动（静态 grep） — Req 13.1 ──
  describe("既有检索 / 河床函数签名未被时空层改动 — Req 13.1", () => {
    it("hippocampus/retrieval.ts 的 retrieveRelevant 签名字符串仍存在且未改动", () => {
      const src = readFileSync(
        join(SRC_ROOT, "hippocampus", "retrieval.ts"),
        "utf8",
      );
      // 既有签名（按当前源码逐行精确匹配，时空层改动会令该子串消失）。
      expect(src).toContain("export function retrieveRelevant(");
      expect(src).toContain("query: string,");
      expect(src).toContain("memory: LayeredMemory,");
      expect(src).toContain(
        "topKOrOpts: number | RetrievalOptions = 10,",
      );
      expect(src).toContain("currentCycle: number = 0");
      expect(src).toContain("): Array<Episode | Concept> {");
    });

    it("riverbed/riverbed-store.ts 的 getActiveRiverbedNodes 签名字符串仍存在且未改动", () => {
      const src = readFileSync(
        join(SRC_ROOT, "riverbed", "riverbed-store.ts"),
        "utf8",
      );
      expect(src).toContain("export function getActiveRiverbedNodes(");
      expect(src).toContain("rb: RiverbedState,");
      expect(src).toContain("now: Date,");
      expect(src).toContain("maxN = 15,");
      expect(src).toContain("): RiverbedNode[] {");
    });
  });
});
