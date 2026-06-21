# OPT-1: 信号采集扩容 (correction_signal)

## 动机

原始飞轮仅接收 `verify_pass` / `verify_fail` 两种信号。用户在实际使用中会产生更多隐式反馈（纠正、放弃、重复使用等），这些被浪费。

## 方案

在 `distiller.ts` 的 `DistillEvent.kind` 中新增 `correction_signal` 类型：

- 当用户对技能输出做修正时触发
- 修正内容写入 `event.payload.correction`
- 蒸馏器将其作为负反馈信号，降低该技能的 `verifiedCount` 权重

信号权重矩阵：
| 信号 | 方向 | 权重 |
|------|------|------|
| verify_pass | 正 | +1.0 |
| verify_fail | 负 | -0.5 |
| correction_signal | 负 | -0.3 |

## 影响

- `src/skill-flywheel/distiller.ts` — 新增 event kind 分支
- `src/riverMain.ts` — 上游采集点发射 correction_signal
- 无破坏性变更，旧数据向后兼容
