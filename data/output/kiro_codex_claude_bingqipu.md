# Kiro / Codex / Claude 可调度入口与分工边界兵器谱

生成时间：本次任务线在线抓取并本机验证

## 1. 结论先看

### Codex（OpenAI）
- 主要可调度入口：`Codex CLI`、`IDE 集成`、`codex app`、`Codex Web`
- 核心定位：本地代码代理，直接在终端/工作区读写和执行
- 边界判断：公开证据更强调“本地运行的 coding agent”和多个使用入口；未在本轮公开资料中直接拿到像 Claude SDK 那样清晰的“官方可编程 agent SDK”说明
- 更适合：本地仓内开发、终端代理执行、IDE/桌面协作

### Claude（Anthropic）
- 主要可调度入口：`Claude Code Terminal CLI`、`VS Code`、`Desktop`、`Web`、`JetBrains`、`Remote Control`、`Slack`、`CI/CD`、`Agent SDK`
- 核心定位：既是交互式 coding agent，也是可编程 agent 平台
- 边界判断：三家里“可程序化调度”最明确；官方直接给出 SDK、hooks、MCP、subagents、structured output、权限控制
- 更适合：把 coding agent 嵌入产品/平台/工作流，做可控自动化与多入口统一编排

### Kiro（AWS/Kiro）
- 主要可调度入口：`Kiro IDE`、`Kiro CLI`、`Kiro Web`、`Hooks`、`Custom Agents`、`MCP`
- 核心定位：偏“工程化 agent 开发环境”，强调 spec-driven development、steering、hooks、长任务与代码正确性验证
- 边界判断：强在需求→设计→任务→执行这条工程链，以及后台 hooks / agent 自动化；公开证据里“像 Claude SDK 那样独立程序库嵌入”不如 Claude 明确
- 更适合：复杂代码库里的规范驱动开发、长任务拆解、团队工程约束落地

## 2. 官方硬证据摘录

### Codex
1. OpenAI 官方 GitHub README 明确：`Codex CLI is a coding agent from OpenAI that runs locally on your computer.`
2. 同页给出多入口：
   - `install in your IDE`
   - `run codex app`
   - `cloud-based agent ... Codex Web`
3. 安装与进入方式给出：
   - `curl -fsSL https://chatgpt.com/codex/install.sh | sh`
   - `npm install -g @openai/codex`
   - `brew install --cask codex`

### Claude
1. Claude Code overview 明确：`Available in your terminal, IDE, desktop app, and browser.`
2. 同页明示能力：`reads your codebase, edits files, runs commands`
3. Claude Agent SDK 页面明确：
   - `Build production AI agents with Claude Code as a library`
   - `read files, run commands, search the web, edit code`
   - `programmable in Python and TypeScript`
4. SDK 页面导航还直接暴露可调度能力面：`MCP`、`hooks`、`subagents`、`structured output`、`permissions`

### Kiro
1. 官网首页明确：`complete long-running tasks across large codebases, validate code correctness with an agent that learns how you work`
2. 官网首页明确：`spec-driven development, advanced steering, and custom agents`
3. CLI 文档列出：
   - `Custom Agents`
   - `MCP Integration`
   - `Smart Hooks`
   - `Agent Steering`
   - `Headless Automation`
   - `CI/CD pipelines using API key authentication`
4. IDE 文档列出能力面：`Specs`、`Hooks`、`Steering`、`MCP Servers`

## 3. 分工边界对比

| 维度 | Codex | Claude | Kiro |
|---|---|---|---|
| 终端代理 | 强 | 强 | 强 |
| IDE/桌面入口 | 有 | 很全 | 有 |
| Web 入口 | 有（Codex Web） | 有 | 有 |
| 官方可编程 SDK/库 | 本轮公开证据不如 Claude 明确 | 最明确 | 本轮未见同等级独立 SDK 证据 |
| Hooks/自动触发 | 本轮证据一般 | 有 hooks | 很强，明确主打 |
| MCP 外部工具接入 | 生态中存在，但本轮证据未做强确认 | 明确支持 | 明确支持 |
| 规范/Specs 驱动 | 非主打表述 | 可做，但非最强标签 | 最强主标签之一 |
| 长任务工程管理 | 有代理能力 | 有代理能力与 SDK 编排 | 强调 long-running tasks |
| 最像“可被上层系统调度的 agent 平台” | 中 | 强 | 中强 |

## 4. 任务线判断

- 如果目标是“把 agent 嵌进自己的系统、批量调度、多入口统一治理”，优先看 `Claude Agent SDK`
- 如果目标是“本地/IDE 里高强度写代码与执行”，`Codex` 很直接
- 如果目标是“让 AI 开发进入工程化轨道，用 specs / hooks / steering 管复杂项目”，`Kiro` 更突出
- 若要组合使用：
  - `Kiro` 负责规格、计划、工程约束
  - `Codex` 负责本地仓快速执行
  - `Claude` 负责对外提供可编排 agent 能力

## 5. 本地验证方式

已生成脚本：`task_output/verify_tool_boundaries.sh`

执行：

```bash
bash task_output/verify_tool_boundaries.sh
```

脚本会在线抓取官方页面/仓库并 grep 出关键证据字符串。