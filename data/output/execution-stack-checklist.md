# 问路执行力增强工具链验收清单

生成时间：$(date '+%Y-%m-%d %H:%M:%S')

## 目标
优先补齐 GitHub 来源的 CLI / 调度 / 验证类工具，并把安装与验收收口为可重复执行的本地清单。

## 已落地工具

| 类别 | 工具 | GitHub / 包来源 | 本地位置 | 验证命令 | 当前结果 |
|---|---|---|---|---|---|
| 调度 | Task | go-task/task | `tools/execution-stack/bin/task` | `tools/execution-stack/bin/task --version` | 通过，`3.44.1` |
| 工作流调度 | n8n | n8n-io/n8n | `tools/execution-stack/n8n` | `tools/execution-stack/n8n/node_modules/.bin/n8n --version` | 通过，`2.23.4` |
| CLI 执行代理 | Claude Code | `@anthropic-ai/claude-code` | `tools/execution-stack/node_modules/.bin/claude` | `tools/execution-stack/node_modules/.bin/claude --version` | 通过，`2.1.168` |
| CLI 执行代理 | Codex CLI | `@openai/codex` | `tools/execution-stack/node_modules/.bin/codex` | `tools/execution-stack/node_modules/.bin/codex --version` | 通过，`0.137.0` |
| MCP 验证/调试 | MCP Inspector | `@modelcontextprotocol/inspector` | `tools/execution-stack/node_modules/.bin/mcp-inspector` | `tools/execution-stack/node_modules/.bin/mcp-inspector --version` | 已安装；直接执行会拉起本地服务，需避开端口占用 |
| CLI 自动化脚本 | zx | google/zx（npm 包 `zx`） | `tools/execution-stack/node_modules/.bin/zx` | `tools/execution-stack/node_modules/.bin/zx --version` | 通过，`8.8.5` |

## 安装脚本
- 安装脚本已固化到 `tools/execution-stack/install-execution-stack.sh`
- 当前能力：安装 Task、n8n、Claude Code、Codex CLI、MCP Inspector、zx，并执行基础验收

## 关键发现
- 仓库原有 `scripts/install-execution-stack.sh` 思路正确，但实际未安装成功，且路径计算不适合迁移后执行。
- `gh` 已安装但当前机器未登录，无法直接用 GitHub API 检索仓库；本轮改用公开包名与已知 GitHub 项目落地。
- `mcp-inspector` 的“验证”行为会启动本地服务，不适合作为纯无副作用版本检查；后续可改成帮助命令或端口隔离验证。

## 建议的下一批候选
- `cli/cli`：GitHub 操作与 release / issue / workflow 调度
- `jqlang/jq`：JSON 验证与结果裁决
- `mikefarah/yq`：YAML / workflow 配置处理
- `casey/just`：轻量任务编排
- `getsops/sops`：密钥与配置加密管理

## 最小验收命令组
```bash
tools/execution-stack/bin/task --version
tools/execution-stack/n8n/node_modules/.bin/n8n --version
tools/execution-stack/node_modules/.bin/claude --version
tools/execution-stack/node_modules/.bin/codex --version
tools/execution-stack/node_modules/.bin/zx --version
```
