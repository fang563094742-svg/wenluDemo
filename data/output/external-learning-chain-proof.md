# 外部学习链路现行证据卡

更新时间：2026-06-08 22:07:19 +0800

## 已结清旧预测
- `https://sxsapi.com/post/857` 本轮再次 `curl` 返回 `200`，旧可达性赌注继续命中。
- 免登录 GitHub API 外部学习链路本轮再次命中：请求 `https://api.github.com/repos/openai/codex/commits?per_page=1` 返回 `200`，最新提交 SHA 为 `8d415050fce4b4ebc6da1ba247379844235fa453`。

## 本轮打穿的外部可验证任务
- 任务 id：`vt1780927622268`
- 目标：证明当前工具链能免登录从 GitHub 外网带回 `openai/codex` 最新提交 SHA
- 现实验收：`verify_task` 返回 `PASSED`（退出码 `0`）

## 现行最短外部学习链路
```bash
cd '/Users/a333/Desktop/问路唯一开发的文件夹/问路的弟弟/wenLuDemo' && \
node -e "const https=require('https');const req=https.get('https://api.github.com/repos/openai/codex/commits?per_page=1',{headers:{'User-Agent':'wenlu','Accept':'application/vnd.github+json'}},res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>{const arr=JSON.parse(d);console.log(JSON.stringify({status:res.statusCode,sha:arr[0]?.sha||''},null,2));});});req.on('error',e=>{console.error(e.message);process.exit(1);});"
```

## 现行边界
- `gh` 当前虽已安装，但未登录；不能把它冒充成默认外部学习入口。
- 当前默认外部学习入口改认：`Node HTTPS + GitHub public API（免登录）`。
- 这条链路已具备“联网取回外部新真值 → 可退出码验证 → 可直接写进判断”的最小闭环。

## 关联本机证据
- 工具链卡：`docs/github-toolchain-card.md`
- 执行力增强清单：`data/output/execution-stack-checklist.md`
- 安装脚本：`tools/execution-stack/install-execution-stack.sh`
