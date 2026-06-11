# Process Baseline Checklist

- 任务假设：把“同题下派→执行→验尸→读回→收口”压成一条最小可运行外部链，外部 LLM 端点应返回“已收到同题基准”。
- 代码草案：`scripts/processBaseline.ts`
- 独立验证脚本：`用户数据/verify-process-baseline.sh`
- 运行产物：`task_output/process-baseline/latest-process-baseline.json`
- 运行摘要：`task_output/process-baseline/latest-process-baseline.md`
- 过程留痕：`data/verifiable-task-chain/process-baseline-trace.md`
- 验收通过标准：外部回包包含“已收到同题基准”；JSON 中 `status=success` 且 `verified=true`；Markdown 与 Trace 同时可读。
- 主人回来可打分点：
  - 是否看见了明确任务假设
  - 是否有可直接审阅的代码草案
  - 是否有一份可单独执行的验尸脚本
  - 是否真正打到了外部回包而不是只做本机整理
