#!/usr/bin/env tsx
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ROOT = resolve('.');
const OUTPUT_DIR = resolve(ROOT, 'task_output', 'front-layered-truth');
const MD_PATH = resolve(OUTPUT_DIR, 'latest-front-layered-truth.md');
const JSON_PATH = resolve(OUTPUT_DIR, 'latest-front-layered-truth.json');
const VERIFY_PATH = resolve(OUTPUT_DIR, 'verify_front_layered_truth.sh');
const VERIFY_TARGET = resolve(OUTPUT_DIR, 'latest-front-layered-truth.md');

interface ProbeResult {
  requestedUrl: string;
  finalUrl: string;
  code: string;
  keyword: string;
  bucket: string;
}

async function run(command: string, args: string[]) {
  const { stdout } = await execFileAsync(command, args, {
    cwd: ROOT,
    maxBuffer: 1024 * 1024 * 8,
  });
  return stdout.trim();
}

async function probe(url: string, keyword: string, bucket: string): Promise<ProbeResult> {
  const script = `import sys, urllib.request
url=sys.argv[1]
kw=sys.argv[2]
req=urllib.request.Request(url, headers={"User-Agent":"Mozilla/5.0"})
with urllib.request.urlopen(req, timeout=20) as r:
    body=r.read().decode("utf-8","ignore")
    final=r.geturl()
    code=str(r.getcode())
print(final)
print(code)
print("1" if kw in body else "0")`;
  const out = await run('python3', ['-c', script, url, keyword]);
  const [finalUrl = '', code = '', hit = '0'] = out.split(/\r?\n/);
  return {
    requestedUrl: url,
    finalUrl,
    code,
    keyword: hit === '1' ? keyword : '',
    bucket,
  };
}

function parseFrontSnapshot(frontRaw: string) {
  const pairs = frontRaw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const idx = line.indexOf('=');
      return [line.slice(0, idx), line.slice(idx + 1)];
    });
  return Object.fromEntries(pairs) as Record<string, string>;
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });

  const frontRaw = await run('bash', ['data/output/safari_front_snapshot.sh']);
  const lines = parseFrontSnapshot(frontRaw);

  const create = await probe(
    'https://channels.weixin.qq.com/platform/post/create',
    '视频号助手',
    '历史公开旁证-较强可操作壳',
  );
  const visitor = await probe(
    'https://login.sina.com.cn/visitor/visitor?a=crossdomain&s=_2AkMdeSyxf8NxqwFRm_ARxG3nbotzzQjEieKrJd1qJRMxHRl-yT9yqk1StRB6NvkCXizMI_AX8TgVij9ooT9hjkOthq9g&sp=0033WrSXqPxfM72-Ws9jqgMF55529P9D9W5CdznTJU6UodG8yQaEv2Oy&from=weibo&_rand=0.614295351125&entry=miniblog&url=https%3A%2F%2Fweibo.com%2F',
    'Sina Visitor System',
    '历史公开旁证-登录壳',
  );
  const xhs = await probe(
    'https://www.xiaohongshu.com/publish/publish',
    '你访问的页面不见了',
    '历史失败壳旁证',
  );

  const generatedAt = new Date().toISOString();
  const frontUrl = lines.url || '';
  const frontTitle = lines.title || '';
  const frontApp = lines.frontApp || '';

  const markdown = `# 第1741次呼吸-当前前台与历史旁证最小预测卡\n\n## 当前前台唯一真值\n- Safari 当前前台页：\`${frontUrl}\`\n- 当前前台应用：${frontApp} / 标签：${frontTitle}\n\n## 历史公开旁证\n- 视频号 create：最终 URL \`${create.finalUrl}\`｜HTTP ${create.code}｜正文关键词：${create.keyword || '未命中'}｜分层：${create.bucket}\n- 微博 visitor：最终 URL \`${visitor.finalUrl}\`｜HTTP ${visitor.code}｜正文关键词：${visitor.keyword || '未命中'}｜分层：${visitor.bucket}\n\n## 历史失败壳旁证\n- 小红书 publish：最终 URL \`${xhs.finalUrl}\`｜HTTP ${xhs.code}｜正文关键词：${xhs.keyword || '未命中'}｜分层：${xhs.bucket}\n\n## 待主人确认预测\n- 预测对象：我下一次在同主题前台回复时的第一句\n- 预测结论：第一句会先锁定 Safari \`http://127.0.0.1:3210/\` 是当前前台唯一真值，再谈历史公开旁证与失败壳旁证。\n- 置信度：0.72\n- 依据：这轮已把三层分界压成单文件卡，并把同主题最常见回滑点收窄到‘第一句先锁当前前台真值’。\n- 可证伪条件：若我下次同主题第一句仍先讲执行动作、旧脚本、历史页或别的口径，而不是先锁 Safari \`http://127.0.0.1:3210/\`，则此预测落空。\n- 备选相反判断：我会再次回滑，第一句没有先锁当前前台唯一真值。\n- 最晚验证时间：主人下次回场并再次追问当前前台页与历史页分界时。\n\n## 生成时间\n- generatedAt: ${generatedAt}\n`;

  const payload = {
    generatedAt,
    frontTruth: {
      app: frontApp,
      title: frontTitle,
      url: frontUrl,
    },
    layers: [create, visitor, xhs],
    prediction: {
      object: '下一次同主题前台回复的第一句',
      claim: '先锁 Safari http://127.0.0.1:3210/ 为当前前台唯一真值，再谈历史旁证分层',
      confidence: 0.72,
      falsifyCondition: '第一句未先锁当前前台唯一真值',
      inverse: '再次回滑，第一句没有先锁当前前台唯一真值',
    },
  };

  const verifyScript = `#!/bin/sh
set -eu
FILE="${VERIFY_TARGET}"
python3 - "$FILE" <<'PY'
import sys, pathlib
p = pathlib.Path(sys.argv[1])
text = p.read_text(encoding='utf-8')
needles = [
    '## 当前前台唯一真值',
    'http://127.0.0.1:3210/',
    '## 历史公开旁证',
    'Sina Visitor System',
    '## 历史失败壳旁证',
    '你访问的页面不见了',
    '## 待主人确认预测',
]
missing = [n for n in needles if n not in text]
raise SystemExit(0 if not missing else 1)
PY
python3 - <<'PY'
import urllib.request
checks = [
    ('https://channels.weixin.qq.com/platform/post/create', '视频号助手'),
    ('https://login.sina.com.cn/visitor/visitor?a=crossdomain&s=_2AkMdeSyxf8NxqwFRm_ARxG3nbotzzQjEieKrJd1qJRMxHRl-yT9yqk1StRB6NvkCXizMI_AX8TgVij9ooT9hjkOthq9g&sp=0033WrSXqPxfM72-Ws9jqgMF55529P9D9W5CdznTJU6UodG8yQaEv2Oy&from=weibo&_rand=0.614295351125&entry=miniblog&url=https%3A%2F%2Fweibo.com%2F', 'Sina Visitor System'),
    ('https://www.xiaohongshu.com/publish/publish', '你访问的页面不见了'),
]
for url, keyword in checks:
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=20) as r:
        body = r.read().decode('utf-8', 'ignore')
    if keyword not in body:
        raise SystemExit(1)
PY
`;

  await writeFile(MD_PATH, markdown, 'utf8');
  await writeFile(JSON_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await writeFile(VERIFY_PATH, verifyScript, { encoding: 'utf8', mode: 0o755 });

  console.log(JSON.stringify({
    generatedAt,
    mdPath: MD_PATH,
    jsonPath: JSON_PATH,
    verifyPath: VERIFY_PATH,
    frontTruth: {
      app: frontApp,
      title: frontTitle,
      url: frontUrl,
    },
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
