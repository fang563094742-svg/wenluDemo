# OPT-5: STRUCTURE.md 自维护机制

## 动机

项目结构文档容易与代码脱节。新增模块后忘记更新 STRUCTURE.md，导致新成员阅读时产生困惑。

## 方案

建立 STRUCTURE.md 自维护约定：

1. **模块注册规则**：每个顶层目录/关键模块在 STRUCTURE.md 中必须有一行描述
2. **变更触发器**：当 `src/` 下新增顶层目录时，CI 检查 STRUCTURE.md 是否包含该目录名
3. **格式规范**：`| 目录/文件 | 职责 | 依赖方向 |`

已完成的补充：
- `bridges/` 目录及 `memory-bridge` 说明
- 飞轮模块各子文件职责表

## 影响

- `STRUCTURE.md` — 新增 bridges/ 等条目
- 可选：CI 脚本检查结构完整性（未实现，低优先级）
