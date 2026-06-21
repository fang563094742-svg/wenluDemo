# Deferred / 前端侧修复项

以下项目在审查 OPT 批次时发现，已在 `wenluDemoWeb` 前端仓库独立修复，后端无需变更。

| 编号 | 标题 | 前端 commit | 状态 |
|------|------|-------------|------|
| A2 | URL XSS 防护 — isSafeUrl 白名单 | `f127ddb` fix(app): URL XSS 防护 | done |
| A3 | Sidebar 布局 — CSS 变量单源化 + 移动端 backdrop | `e7aefe4` feat(app/sidebar) | done |

## 说明

- A2：前端 `renderMarkdown()` 中所有 `<a href>` 经 `isSafeUrl()` 过滤，拒绝 `javascript:`/`data:`/`vbscript:` 协议。后端已有独立的 SSRF 加固（commit `A2 URL SSRF`）。
- A3：前端 sidebar 展开/收起通过 CSS 变量 `--sidebar-width` 驱动 `input-area` 偏移，移除硬编码 `left=220px`。后端无关联。
