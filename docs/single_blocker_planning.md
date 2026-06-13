# 单点阻塞收缩规划规范

目标：把任意任务线稳定收缩为“一个当前可做的下一步”，避免同时追多条阻塞链而持续发散。

## 使用时机
- 接到新目标，需要先拆解执行。
- 发现任务列表里同时存在多个 blocked/pending 项，不确定该先动哪个。
- 连续两轮以上只是补充背景、没有产生可执行下一步。

## 数据结构
每个任务项至少包含：
- `id`: 稳定标识
- `title`: 可执行动作名词化，不写愿景口号
- `status`: `pending | in_progress | blocked | done`
- `priority`: 数字，越小越高；建议 10/20/30 分档
- `blockedBy`: 依赖的上游任务 id 列表
- `evidence`: 已有证据，证明该项为何存在或已推进

## 拆解规则
1. 只拆到“单步可执行”粒度：一次 shell / 一次读取 / 一次切换 / 一次验证。
2. 下游项必须显式写 `blockedBy`，不要用自然语言隐含依赖。
3. 优先级按“解阻杠杆”排，而不是按叙述顺序排；数字越小优先级越高。
4. 任意时刻只允许一个 `in_progress`；若出现多个，先降回 pending，再重新收缩。
5. 如果存在 ready 项（无未完成依赖），直接做最小 `priority` 的 ready 项；不要跳去处理 blocked 项。
6. 如果没有 ready 项，找所有 blocked 链的根阻塞，只选最小 `priority` 的一个作为当前唯一阻塞。
7. 缺失 `priority` 的任务默认视为最低优先级，避免压过已明确排序的任务。

## 推荐流程
1. 先写出 3-7 个任务项。
2. 运行 `shrinkToSingleBlocker` 计算：
   - `highestPriorityReady`
   - `uniqueBlocker`
   - `nextAction`
3. 只执行 `nextAction` 对应项。
4. 执行后立刻更新状态与 evidence，再次收缩。

## 失败信号
- 同时讨论两个以上 blocker。
- 下一步仍然是“继续分析/继续看看”。
- 任务项没有 blockedBy，导致依赖关系靠猜。
- 同一批任务在文档、代码、CLI 中对 `priority` 方向解释不一致。

## 收口标准
规划闭环成立的证据是：
- 给定一组任务项，规划器总能输出唯一 nextAction。
- 当 ready 项存在时，nextAction 必须落在最小 `priority` 的 ready 项。
- 当没有 ready 项时，nextAction 必须收缩为最小 `priority` 的一个根阻塞，而不是列一串建议。
