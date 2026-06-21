# 验收证据链协议 (Verification Evidence Chain Protocol)

## 核心原则

任何任务的完成/失败判定，必须有**三层证据链**交叉验证，而非仅凭"我做了"的主观声明。

## 三层证据结构

### L1: 执行证据 (Execution Evidence)
证明动作确实被执行。

| 证据类型 | 验证方法 | 示例 |
|---------|---------|------|
| 文件创建/修改 | `--check-file <path>` + `file_fresh` | 文件存在且修改时间在预期窗口内 |
| 命令执行 | 命令输出/退出码 | `echo $?` = 0 |
| Git 变更 | `git diff --stat` | 有预期的文件出现在 diff 中 |

### L2: 状态证据 (State Evidence)  
证明结果确实生效。

| 证据类型 | 验证方法 | 示例 |
|---------|---------|------|
| 服务运行 | `--check-port <port>` / `--check-http <url>` | 端口监听 / HTTP 200 |
| 内容正确 | `--check-content <file> <pattern>` | 文件含预期内容 |
| 测试通过 | `--check-cmd "npm test"` | 退出码 0 |
| 功能可用 | 实际调用产生预期响应 | API 返回正确 JSON |

### L3: 回归证据 (Regression Evidence)
证明未引入破坏。

| 证据类型 | 验证方法 | 示例 |
|---------|---------|------|
| 无新错误 | 日志无 error/exception/fatal | `--check-no-errors <log>` |
| 既有测试绿 | 原有测试套件通过 | `--check-cmd "npm test"` |
| 语法正确 | lint/编译无报错 | `sh -n script.sh` / `tsc --noEmit` |

## 使用方式

### 单项检查
```sh
sh tools/verify_evidence_chain.sh --check-file ./output.json
sh tools/verify_evidence_chain.sh --check-port 3000
sh tools/verify_evidence_chain.sh --check-cmd "node -e 'require(\"./index\")'"
sh tools/verify_evidence_chain.sh --check-content ./config.json '"port": 8080'
sh tools/verify_evidence_chain.sh --check-http http://localhost:3000/health
```

### 清单批量验证
创建 `.verify` 清单文件（`|` 分隔：层级|检查类型|参数）：
```
# 示例验证清单
L1|file_exists|./dist/index.js
L1|file_fresh|./dist/index.js 5
L2|port|3000
L2|http|http://localhost:3000/health
L2|content|./dist/index.js module.exports
L3|cmd|npm test
L3|no_errors|./logs/app.log
```

执行：
```sh
sh tools/verify_evidence_chain.sh --full ./task.verify
```

### 自检
```sh
sh tools/verify_evidence_chain.sh --self-test
```

## 退出码约定

| 码 | 含义 |
|----|------|
| 0 | 全部通过 |
| 1 | 有 hard-gate 失败（任务未完成） |
| 2 | 仅 soft-signal 警告（任务基本完成但有隐患） |

## 与任务系统集成

每个 `declare_verifiable_task` 的 assertions 应映射到本脚本的检查项：

- `probeType: file` → `--check-file`
- `probeType: shell` → `--check-cmd`
- `probeType: http` → `--check-http`
- `probeType: state` → `--check-content` 或自定义

## 最佳实践

1. **任务开始前**：用 `declare_verifiable_task` 声明断言
2. **任务执行中**：每步保留中间产物（不删临时输出）
3. **任务结束时**：运行 `--full` 清单验证，或调用 `verify_task`
4. **验证失败时**：保留失败证据，记录根因，不假装通过
