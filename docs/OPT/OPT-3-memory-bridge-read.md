# OPT-3: memory-bridge 隔离读取优化

## 动机

memory-bridge 原始实现在每次 `readMind()` 时做完整 JSON 解析，即使只需要读取 `skillFlywheel` 或某个局部字段。大 mind 文件（>50KB）时性能损耗明显。

## 方案

引入分层读取策略：

1. **热路径缓存**：`resolveFlywheelConfig` 结果缓存至下次写入
2. **选择性解析**：`readMindSection(key)` 仅解析需要的顶层字段
3. **写时失效**：任何 `writeMind` 操作自动清除缓存

实现约束：
- 缓存仅在同一 river tick 内有效（防止跨 tick 脏读）
- 内存上限 1MB，超出自动降级为全量解析

## 影响

- `src/bridges/memory-bridge.ts` — 新增 section cache 逻辑
- `src/skill-flywheel/flywheel-config.ts` — `resolveFlywheelConfig` 签名不变
- 零外部行为变更，纯内部优化
