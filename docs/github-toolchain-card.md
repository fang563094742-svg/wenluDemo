# GitHub 工具链卡（现行唯一版）

更新时间：2026-06-08 21:51:37 +0800

## 已实机验尸的工具

### 1. GitHub CLI
- 可执行文件：`/Users/a333/.local/bin/gh`
- 版本命令：`gh --version`
- 实测结果：`gh version 2.92.0 (2026-04-28)`
- 帮助命令：`gh help`
- 结论：已安装、可正常启动、主命令帮助可用

### 2. Git
- 可执行文件：`/usr/bin/git`
- 版本命令：`git --version`
- 实测结果：`git version 2.50.1 (Apple Git-155)`
- 帮助命令：`git help -a`
- 结论：已安装、可正常启动、命令全集帮助可用

## 本机未发现的候选相关工具
以下命令 `command -v` 未命中：
- `github`
- `hub`
- `glab`
- `git-credential-manager`
- `git-lfs`

## 现行唯一工具链
只认下面这组，避免“装了但没证”：
- GitHub 平台 CLI：`gh`
- Git 版本控制：`git`

## 标准验尸命令
```bash
command -v gh && gh --version && gh help
command -v git && git --version && git help -a
```

## 收口判断
- 当前与 GitHub 直接相关且已验尸通过的现行工具链为：`gh + git`
- 其余候选工具在本机当前环境未发现，不纳入现行卡
