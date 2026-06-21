# OPT-4: Router 最小相关度阈值

## 动机

无阈值时，router 会返回所有候选技能（包括相关度极低的），导致下游处理噪声大、延迟增加。

## 方案

在 `FlywheelRankingParams` 中新增 `routerMinRelevance`（默认 0.3）：

- `searchSkills` 排序后，过滤掉 `rel < routerMinRelevance` 的结果
- 阈值可通过 mind 配置动态调整
- 0 表示不过滤（向后兼容）

过滤位置在排序之后、返回之前，确保 UCB1 探索计算不受影响。

## 影响

- `src/skill-flywheel/skill-kb.ts:searchSkills` — 新增 filter 步骤
- `src/skill-flywheel/flywheel-config.ts` — `FlywheelRankingParams` 新增字段
- 测试新增 routerMinRelevance 边界用例
