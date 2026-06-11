import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const outputDir = process.argv[2] || '用户数据/task_output/web_multi_site_2314_h4';
mkdirSync(outputDir, { recursive: true });

const card = `# 第2314次呼吸-web难度4多站正文级知识卡

## 当前前台唯一真值
- Safari \`http://127.0.0.1:3210/\`

## 外部对象
- MDN 451 参考页：\`https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status/451\`
- RFC 7725 纯文本：\`https://www.rfc-editor.org/rfc/rfc7725.txt\`
- HTTPWG RFC 7725 HTML：\`https://httpwg.org/specs/rfc7725.html\`
- httpstatuses 451 摘要页：\`https://httpstatuses.io/451\`

## 四分判断
1. MDN 451 页应命中 \`Unavailable For Legal Reasons\`。
2. RFC 7725 纯文本应命中 \`451 Unavailable For Legal Reasons\`。
3. HTTPWG HTML 规范页应命中 \`legal obstacles\`。
4. httpstatuses 摘要页应命中 \`legal reasons\`。

## 约束
- 这是外部正文级知识闭环，不是当前前台页推进。
- 四站页面结构不同：参考文档、纯文本RFC、HTML规范、摘要页。
`;

writeFileSync(join(outputDir, '第2314次呼吸-web难度4多站正文级知识卡.md'), card);
console.log(join(outputDir, '第2314次呼吸-web难度4多站正文级知识卡.md'));
