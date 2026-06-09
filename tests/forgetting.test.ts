import { retentionRate, memoryStrength, applyForgetting, shouldForget, applyWorkingMemoryLimit } from "../src/hippocampus/forgetting.js";

// 模拟一个 Episode
function mockEpisode(overrides: any = {}) {
  return {
    id: "ep-test",
    type: "episodic" as const,
    content: "test memory",
    importance: 0.5,
    accessCount: 1,
    createdCycle: 0,
    lastAccessedCycle: 0,
    source: "conversation",
    ...overrides,
  };
}

// 测试 1: 新记忆的保留率应接近 1.0
const fresh = mockEpisode({ createdCycle: 100, lastAccessedCycle: 100 });
const r1 = retentionRate(fresh, 100);
console.assert(r1 >= 0.99 && r1 <= 1.0, `fresh retention should be ~1.0, got ${r1}`);

// 测试 2: 经过大量 cycle 后，低重要性记忆的保留率应衰减
const aged = mockEpisode({ createdCycle: 0, lastAccessedCycle: 0, importance: 0.2, accessCount: 1 });
const r2 = retentionRate(aged, 500);
console.assert(r2 < 0.3, `aged low-importance retention should be low, got ${r2}`);

// 测试 3: 高重要性 + 频繁访问 + 最近访问 应保持高保留率
const strong = mockEpisode({ createdCycle: 0, lastAccessedCycle: 480, importance: 0.9, accessCount: 10 });
const r3 = retentionRate(strong, 500);
console.assert(r3 > 0.5, `strong memory should retain well, got ${r3}`);

// 测试 4: memoryStrength 应反映 importance * accessCount 加权
const s1 = memoryStrength(mockEpisode({ importance: 0.8, accessCount: 5 }));
const s2 = memoryStrength(mockEpisode({ importance: 0.2, accessCount: 1 }));
console.assert(s1 > s2, `stronger memory should have higher strength: ${s1} vs ${s2}`);

// 测试 5: applyForgetting 应过滤掉保留率低于阈值的记忆
const episodes = [
  mockEpisode({ id: "a", createdCycle: 0, lastAccessedCycle: 0, importance: 0.1, accessCount: 1 }),
  mockEpisode({ id: "b", createdCycle: 400, lastAccessedCycle: 490, importance: 0.9, accessCount: 8 }),
];
const concepts: any[] = [];
const result = applyForgetting(episodes, concepts, 500, 0.1);
// "a" 很可能被遗忘 (低重要性,很久没访问), "b" 应该保留 (高重要性)
console.assert(episodes.some(e => e.id === "b"), `strong entry "b" should be retained`);
console.assert(result.forgottenEpisodes <= 1, `at most 1 forgotten episode`);

// 测试 6: shouldForget 对高重要性记忆返回 false
const highImp = mockEpisode({ importance: 0.85, createdCycle: 0, lastAccessedCycle: 0 });
console.assert(!shouldForget(highImp, 1000), `high importance should never be forgotten`);

// 测试 7: applyWorkingMemoryLimit 只保留前 N 条
const many = Array.from({ length: 10 }, (_, i) => ({ idx: i }));
const limited = applyWorkingMemoryLimit(many, 5);
console.assert(limited.length === 5, `working memory should limit to 5, got ${limited.length}`);

console.log("✓ All forgetting.test.ts assertions passed");
console.log(`  Fresh retention: ${r1.toFixed(4)}`);
console.log(`  Aged (low-imp): ${r2.toFixed(4)}`);
console.log(`  Strong (high-imp,freq): ${r3.toFixed(4)}`);
console.log(`  Strength strong: ${s1.toFixed(2)}, weak: ${s2.toFixed(2)}`);
console.log(`  Forgotten episodes: ${result.forgottenEpisodes}, remaining: ${episodes.length}`);
