# OPT-2: UCB1 排序公式优化

## 动机

初始排序公式线性加权 `exploit + explore + fresh`，未考虑 relevance 与 exploit 的乘性关系。高 rel 的技能即使 exploit 稍低也应优先于低 rel 高 exploit 的技能。

## 方案

将排序公式从加法模型改为乘法模型：

```
score = rel * (exploit + exploreWeight * explore + freshWeight * fresh)
```

- `rel` 作为主因子，乘以后续加法项
- `exploreWeight` / `freshWeight` 通过 `FlywheelRankingParams` 可调
- UCB1 探索项公式：`C * sqrt(ln(N) / n_i)`，其中 C 默认 0.5

## 影响

- `src/skill-flywheel/skill-kb.ts:searchSkills` — 排序函数重写
- `src/skill-flywheel/flywheel-config.ts` — 新增 `exploreWeight` / `freshWeight` 参数
- 已有测试全量覆盖排序不变式（A1 测试）
