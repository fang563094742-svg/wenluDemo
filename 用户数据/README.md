# 用户数据 — 问路弟弟版的唯一数据持久化根

> 数据架构师视角下的目录契约：所有问路相关的用户数据、用户进化痕迹、问路写过的工具/文档，
> 全部归这一个根目录。`getWenluDataDir()` 默认返回此目录。

## 设计原则

1. **PG 是权威数据存储**（`brain` / `memory` / `conversation_message` / `sensor_state` 等表，按 `user_id` 隔离 + RLS）
2. **本目录是文件 artifact 持久化层**（脚本、截图证据、流水、备份等无法 JSONB 化的内容）
3. **per-user 子目录与 PG `users.id` 一一对应**：`users/<UUID>/...`
4. **System_User**（迁移期单用户哨兵）UUID = `00000000-0000-0000-0000-000000000000`
5. **新注册用户** auth/routes 注册成功后会自动建 `users/<新UUID>/`

## 目录结构

```
用户数据/                                     ← getWenluDataDir() 默认根
├── README.md                                ← 本文件
│
├── autonomy/                                ← 系统级证据（不属于具体用户）
│   └── native_app_focus_latest.json         ← focus_native_app 工具的现场快照
│
├── users/                                   ← per-user 子目录（每个 UUID = 一个 users.id）
│   └── 00000000-0000-0000-0000-000000000000/   ← System_User（你本机历史数据归这）
│       ├── mind.json                        ← Mind 主体（PG brain 表的镜像备份）
│       ├── memory.json                      ← 分层记忆（PG memory 表的镜像备份）
│       ├── topics.json                      ← 旧 channels 概念
│       ├── connector.json                   ← 连接器配置
│       ├── action-ledger.ndjson             ← P1-5 工具调用流水（NDJSON）
│       ├── _hist.tmp                        ← 历史 tmp
│       ├── monitor_services.json            ← 监控服务配置
│       ├── mind-backups/                    ← mind.json 历史备份（55+ 份）
│       ├── bin/                             ← per-user 工具脚本（chess_*、native_*）
│       ├── sensors/                         ← 传感器实例（_state.json + 各 sensor 子目录）
│       ├── tools/                           ← 问路自己生成的工具
│       ├── toolchains/                      ← 工具链配置
│       ├── self_code/                       ← 自我修改痕迹
│       ├── monitor_logs/                    ← 监控日志
│       ├── artifacts/                       ← 任务产物
│       ├── taskline_artifacts/              ← 任务线产物
│       ├── evidence/                        ← 验证证据 (native_truth/ etc)
│       ├── verification/                    ← 验证流水
│       ├── verification-evidence/           ← 验证证据
│       ├── verification_evidence/           ← 单独导入的验证证据 (~/verification_evidence/)
│       ├── chess/                           ← 国际象棋全部进化数据 (2.1GB)
│       │   ├── observations/
│       │   ├── observer/
│       │   ├── actions/
│       │   ├── move_evidence/
│       │   └── Chess/
│       ├── kiro_probes/                     ← 问路写到 ~/.kiro/probes/ 的探针
│       ├── kiro_tools/                      ← 问路写到 ~/.kiro/tools/ 的工具
│       ├── kiro_sensors/                    ← 问路写到 ~/.kiro/sensors/ 的传感器
│       ├── user_models/                     ← 问路对你的理解 (.kiro 下的 understanding/hypothesis 文档)
│       ├── verification_tools/              ← 问路写到 ~/Developer/tools/ 的验证工具
│       └── local_swift/                     ← 问路写到 ~/.local/bin/ 的 swift 探针
│
└── _archive/                                ← 历史归档（已停用、留作恢复证据）
    ├── 3.1后端/                              ← 旧 Next.js 版的 .runtime / .funsoul-data 等
    ├── macLibrary/                          ← Mac App 的 Library 数据（Application Support、Logs、Containers、HTTPStorages、Preferences、Application Scripts、WebKit）
    ├── macLibrary_caches/                   ← Mac App 缓存（com.wenlu.*、wenlu-bridge*、WenluMacApp）
    └── launchd_plists/                      ← 7 个已 unload 的 LaunchAgent plist 备份
```

## 迁移记录

**首次归类时间**：2026-06-17

**数据来源 → 目标**：

| 来源 | 目标 |
|---|---|
| `wenluDemo/.wenlu-local/*` | `users/00000000.../` |
| `~/.wenlu/*` (非棋谱) | `users/00000000.../` (合并) |
| `~/.wenlu/chess_*` + `chess-observer` | `users/00000000.../chess/` |
| `~/.kiro/probes,tools,sensors` | `users/00000000.../kiro_*` |
| `~/.kiro/understanding_*.md`, `user_hypothesis_*.md` | `users/00000000.../user_models/` |
| `~/Developer/tools/` | `users/00000000.../verification_tools/Developer_tools/` |
| `~/.local/bin/*.swift` | `users/00000000.../local_swift/` |
| `~/verification_evidence/` | `users/00000000.../verification_evidence/` |
| `3.1后端/.runtime`, `.funsoul-data` 等 | `_archive/3.1后端/` |
| `~/Library/{Application Support,Logs,Containers,HTTPStorages,Preferences,Application Scripts,WebKit}/wenlu*` | `_archive/macLibrary/` |
| `~/Library/Caches/{com.wenlu.*,wenlu-bridge*,WenluMacApp}` | `_archive/macLibrary_caches/` |
| `~/Library/LaunchAgents/com.wenlu.*.plist` (7) | `_archive/launchd_plists/` |

**未动**：
- 桌面顶层文件夹（赚钱、认知奇点、问路企业版 等用户内容）按用户要求保持原位
- 桌面 `wenlu_*` 备份文件夹（你之前的备份，不动避免覆盖）

## .gitignore 约定

```
用户数据/users/*
用户数据/_archive/
用户数据/autonomy/*.json
```

只把空目录骨架 + 本 README 入 git。所有 user data 不入 git（隐私 + 体积）。

## 新用户注册自动建子目录

`auth/routes.ts` 注册流程会调用 `UserSession.init(userId)` →  
`mkdir -p 用户数据/users/<userId>/` → mind/memory 自动按 per-user 落盘。

## 恢复方法（旧路径 → 新路径）

如果有代码或工具还在引用 `~/.wenlu/...` / `~/.kiro/probes` / `~/Developer/tools` 等老路径，
临时 fallback 通过软链恢复（不建议，应改代码用 `getWenluDataDir()`）：

```bash
ln -s "/Users/a333/Desktop/问路唯一开发的文件夹/问路的弟弟/wenluDemo/用户数据/users/00000000-0000-0000-0000-000000000000" ~/.wenlu_new
```

## 关键 SQL 哨兵

System_User 的固定 UUID 在 `db/migrations/003_brain_store.sql` 写死：

```sql
INSERT INTO users (id, nickname)
VALUES ('00000000-0000-0000-0000-000000000000', 'local')
ON CONFLICT (id) DO NOTHING;
```

`db/systemUser.ts` 的 `SYSTEM_USER_ID` 常量与此对齐。
