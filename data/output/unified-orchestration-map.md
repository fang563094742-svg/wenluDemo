# 统一总调度图（Codex / Kiro / Claude 当前现行版）

- 生成时间：2026-06-08T08:44:00Z
- 目标：核验 Codex / Kiro / Claude 当前可调度入口与边界，收成唯一现行兵器谱与默认调度法。
- 方法：只记录本轮真实验尸成功的入口与边界，不拿安装状态冒充执行能力。

## 1. 控制面总览

| 控制面 | 当前真实入口 | 本轮已验尸能力 | 当前边界 | 默认角色 |
|---|---|---|---|---|
| Codex | `codex` CLI + `Codex.app` | `--help`、`doctor`、`exec` 非交互成功、可前台化、可列 MCP | 远程插件同步依赖 ChatGPT auth；部分 MCP 握手超时/Unsupported | 主执行器 / 主调度器 |
| Kiro | `kiro` CLI + `Kiro.app` | `--help`、`--goto`、扩展枚举、可前台化 | 仅确认编辑器控制面，未确认 agent 闭环 | 编辑器辅兵 / 人工接管位 |
| Claude | `Claude.app` + `open -a Claude` | 可拉起、可前台化、可观测进程 | 未确认 CLI；未确认脚本化对话接口 | 备用脑 / 人工评审位 |
| 本机控制面 | `zsh/bash` + `osascript` + `open` | shell 与 GUI 控制都可用 | 不做不可逆整盘动作 | 最终兜底执行面 |

## 2. 默认分工
- Codex：默认接总目标，负责拆分、执行、搜证、产物落盘。
- Kiro：只接文件定位、差异查看、合并与人工编辑动作。
- Claude：只在需要备用判断或文字润色时进入，不进关键自动执行链。
- 本机控制面：作为所有桌面工具失败后的兜底动作面。

## 3. 默认下派顺序
1. Codex 先接任务并尝试直接完成。
2. 若需可视编辑或跳文件，转给 Kiro。
3. 若需人工补脑或审稿，再切 Claude。
4. 任一工具失灵，退回 shell + osascript + open。

## 4. 失败降级链
- Codex `exec` 失灵：退回 shell 命令 + 文件直改。
- Kiro 失灵：回 Codex 直接读写文件，不阻塞主链。
- Claude 失灵：直接跳过，不进入强依赖验收链。
- 桌面应用脚本失灵：只保留 CLI 与底层证据，不靠 GUI 成败决定结论。

## 5. 本轮证据
- Codex｜通过｜`codex --help`｜CLI 子命令面存在
- Codex｜通过｜`codex doctor`｜安装/认证/MCP/sandbox 信息可读
- Codex｜通过｜`codex exec --skip-git-repo-check --sandbox workspace-write 'Reply with exactly: CODEX_EXEC_OK' </dev/null`｜返回 `CODEX_EXEC_OK`
- Codex｜通过｜`osascript -e 'tell application "Codex" to activate'`｜退出码 0
- Codex｜部分通过｜`codex mcp list`｜可枚举 `computer-use` / `node_repl` / `playwright`，但非全部已闭环
- Kiro｜通过｜`kiro --help`｜`goto/diff/merge/add` 可见
- Kiro｜通过｜`kiro --goto package.json:1:1 --reuse-window`｜退出码 0
- Kiro｜通过｜`kiro --list-extensions --show-versions`｜可枚举扩展
- Kiro｜通过｜`osascript -e 'tell application "Kiro" to activate'`｜退出码 0
- Claude｜通过｜`open -a Claude`｜应用可拉起
- Claude｜通过｜`osascript -e 'tell application "Claude" to activate'`｜退出码 0
- Claude｜通过｜`System Events` 观测 Claude 进程｜前台/运行态可确认

## 6. 统一判词
- **当前唯一成熟的可编排主兵器是 Codex。**
- **Kiro 当前是编辑器型辅兵，不是独立 agent 主兵器。**
- **Claude 当前只有桌面入口，没有被本轮确认的 CLI 调度面。**
