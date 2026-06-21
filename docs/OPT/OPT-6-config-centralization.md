# OPT-6: 飞轮配置单源化 (FlywheelConfig)

## 动机

早期开发中排序参数散落在多处（skill-kb 默认值、riverMain 硬编码、测试 fixture），修改一处漏改另一处造成行为不一致。

## 方案

将所有飞轮配置集中到 `flywheel-config.ts`：

1. **类型定义**：`FlywheelConfig` / `FlywheelRankingParams` / `FlywheelToggles`
2. **默认值**：`DEFAULT_FLYWHEEL` / `DEFAULT_RANKING` 作为唯一真相源
3. **解析函数**：`resolveFlywheelConfig(mind)` 从 mind 数据规整出完整配置
4. **消费方式**：所有模块通过 import 获取默认值，不允许本地 hardcode

配置层级：mind 持久化 > resolveFlywheelConfig 规整 > 消费方使用

## 影响

- `src/skill-flywheel/flywheel-config.ts` — 配置中心
- `src/riverMain.ts` — 通过 `resolveFlywheelConfig(mind)` 获取
- `src/skill-flywheel/skill-kb.ts` — 参数通过函数签名传入
- 消除了 magic number，便于 A/B 测试不同参数组合
