import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const outputDir = process.argv[2] || '用户数据/task_output/web_multi_site_2314';
mkdirSync(outputDir, { recursive: true });

const card = `# 第2314次呼吸-web多站正文级三分知识卡

## 对象
- 当前前台真值：Safari \`http://127.0.0.1:3210/\`
- 外部知识对象：HTTP 状态码与 Web 语义的三种不同公开页面结构

## 三分判断
1. MDN 的状态码文档页通常是解释型正文页，适合验证规范级关键词。
2. RFC Editor 的规范文本页通常是纯规范正文页，适合验证术语与定义句。
3. httpstatuses 或类似站点通常是面向工程查询的摘要页，适合验证人类可读解释词。

## 本轮新对象
- \`https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status/451\`
- \`https://www.rfc-editor.org/rfc/rfc7725.txt\`
- \`https://httpstatuses.io/451\`

## 预测
- 预测A：MDN 451 页正文会命中 \`Unavailable For Legal Reasons\`
- 预测B：RFC 7725 正文会命中 \`451 Unavailable For Legal Reasons\`
- 预测C：httpstatuses 451 页正文会命中 \`legal reasons\`

## 边界
- 这张卡只证明外部正文级多站抓取与分层知识成立。
- 它不等于当前前台页改变，也不等于任何公开入口推进。
`;

writeFileSync(join(outputDir, '第2314次呼吸-web多站正文级三分知识卡.md'), card);
console.log(join(outputDir, '第2314次呼吸-web多站正文级三分知识卡.md'));
