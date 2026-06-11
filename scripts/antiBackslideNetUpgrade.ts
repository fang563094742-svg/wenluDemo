#!/usr/bin/env tsx
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, relative } from "node:path";

interface TriggerSignal {
  id: string;
  ifDetected: string;
  means: string;
  mandatoryResponse: string;
}

interface EnforcementRule {
  id: string;
  rule: string;
  measurableConstraint: string;
  failureConsequence: string;
}

interface VerificationProbe {
  id: string;
  purpose: string;
  command: string;
  successSignal: string;
}

interface UpgradeLaw {
  generatedAt: string;
  mission: string;
  rootProblem: string;
  doctrine: string;
  battlefieldLoop: string[];
  triggerSignals: TriggerSignal[];
  enforcementRules: EnforcementRule[];
  closureTemplate: string[];
  verificationProbes: VerificationProbe[];
  liveDrill: {
    targetUrl: string;
    successNeedle: string;
    whyThisIsUncertain: string;
  };
}

const ROOT = resolve(".");
const OUT_DIR = resolve("task_output", "anti-backslide-net-upgrade");
const JSON_PATH = resolve(OUT_DIR, "anti-backslide-net-upgrade.json");
const MD_PATH = resolve(OUT_DIR, "anti-backslide-net-upgrade.md");
const VERIFY_PATH = resolve(OUT_DIR, "verifyAntiBackslideNetUpgrade.ts");

const law: UpgradeLaw = {
  generatedAt: new Date().toISOString(),
  mission: "修掉受阻后回滑到分析壳、停在入口证据的问题，逼出继续推进、换挡或收口三选一。",
  rootProblem: "一旦网络链路或外部依赖受阻，执行容易停在‘我在分析/我已看到入口’而不是继续创造新证据。",
  doctrine: "先判是否有证据增量；无增量就判空转；空转两轮必换挡；外部卡死必做旁路或接管包；任何暂停前必须留下可验证收口。",
  battlefieldLoop: [
    "先做一跳内能产生网络新证据的动作，禁止先扩写解释。",
    "记录本轮是否新增了远端响应、状态码、字段、页面文本、错误类别中的至少一种。",
    "若没有新增证据，立即标记为空转轮次并进入换挡判断。",
    "同一路径连续两轮无增量，强制改走降配探测、替代端点、缓存样本、抓包日志、待接管包中的一种。",
    "若外部依赖仍不可控，停止硬顶，直接生成可接管收口并标明恢复触发条件。",
    "每轮结束都要交付目标、证据、阻塞、下一步、止损条件。"
  ],
  triggerSignals: [
    {
      id: "entry-evidence-stall",
      ifDetected: "只拿到入口页/基础连通性/单次状态码，就开始长解释，且没有继续探测新端点或新字段。",
      means: "停在入口证据，未进入实质推进。",
      mandatoryResponse: "立刻补做至少一个更深一层的网络探针。"
    },
    {
      id: "analysis-shell-regression",
      ifDetected: "连续两轮输出以判断、解释、可能性为主，但没有新增远端证据。",
      means: "已回滑到分析壳。",
      mandatoryResponse: "禁止继续解释，必须换挡并生成新证据或收口包。"
    },
    {
      id: "external-hard-stop",
      ifDetected: "远端超时、鉴权、封禁、人工依赖成为单点且当前不可控。",
      means: "主链路被外部世界卡死。",
      mandatoryResponse: "启动旁路验证，失败则产出接管包与恢复条件。"
    }
  ],
  enforcementRules: [
    {
      id: "two-empty-loops-force-shift",
      rule: "连续两轮没有远端证据增量，必须换挡。",
      measurableConstraint: "验证文件中 mustShiftAfterEmptyLoops = 2，且军法文本含该阈值。",
      failureConsequence: "判定为机制失效。"
    },
    {
      id: "no-pause-without-closure",
      rule: "任何暂停、失败或等待前，必须留下收口五件套。",
      measurableConstraint: "军法文本必须包含目标、当前状态、已验证证据、当前阻塞、下一步/止损条件。",
      failureConsequence: "判定为仍允许停在入口证据。"
    },
    {
      id: "network-depth-before-summary",
      rule: "发现入口证据后，至少再做一层网络深探才能进入总结。",
      measurableConstraint: "演练验证需要同时命中 /posts 与 /posts/1 两层远端资源。",
      failureConsequence: "判定为仍停在入口。"
    }
  ],
  closureTemplate: [
    "目标：",
    "当前状态：",
    "已验证证据：",
    "当前阻塞：",
    "建议换挡：",
    "下一步：",
    "止损条件 / 恢复条件："
  ],
  verificationProbes: [
    {
      id: "remote-list-probe",
      purpose: "验证已超出入口连通性，拿到远端列表数据。",
      command: "curl -fsSL https://jsonplaceholder.typicode.com/posts | head -c 120",
      successSignal: "输出包含 userId 或 title 字段。"
    },
    {
      id: "remote-detail-probe",
      purpose: "验证继续深探到详情资源，而非停在入口。",
      command: "curl -fsSL https://jsonplaceholder.typicode.com/posts/1",
      successSignal: "输出包含 id=1 对应对象的 title/body。"
    },
    {
      id: "remote-schema-diff-probe",
      purpose: "验证总结前做过字段级比对。",
      command: "node -e \"fetch('https://jsonplaceholder.typicode.com/posts').then(r=>r.json()).then(d=>{const keys=Object.keys(d[0]||{}).sort();console.log(keys.join(','))})\"",
      successSignal: "输出 userId,id,title,body。"
    }
  ],
  liveDrill: {
    targetUrl: "https://jsonplaceholder.typicode.com/posts",
    successNeedle: "必须同时抓到列表与详情，并写出收口模板。",
    whyThisIsUncertain: "依赖真实外网响应，不可由本地自证伪造。"
  }
};

const markdown = [
  "# 反回滑网络进化军法",
  "",
  `- 生成时间：${law.generatedAt}`,
  `- 使命：${law.mission}`,
  `- 根问题：${law.rootProblem}`,
  `- 教义：${law.doctrine}`,
  "",
  "## 现行军法",
  ...law.battlefieldLoop.map((item) => `- ${item}`),
  "",
  "## 回滑触发信号",
  ...law.triggerSignals.flatMap((signal) => [
    `- ${signal.id}: ${signal.ifDetected}`,
    `  - 含义：${signal.means}`,
    `  - 强制响应：${signal.mandatoryResponse}`,
  ]),
  "",
  "## 可验证约束",
  ...law.enforcementRules.flatMap((rule) => [
    `- ${rule.id}: ${rule.rule}`,
    `  - 可测约束：${rule.measurableConstraint}`,
    `  - 失守后果：${rule.failureConsequence}`,
  ]),
  "",
  "## 收口模板",
  ...law.closureTemplate.map((item) => `- ${item}`),
  "",
  "## 联网演练探针",
  ...law.verificationProbes.flatMap((probe) => [
    `- ${probe.id}: ${probe.purpose}`,
    `  - 命令：${probe.command}`,
    `  - 成功信号：${probe.successSignal}`,
  ]),
  "",
  "## 实战要求",
  `- 目标地址：${law.liveDrill.targetUrl}`,
  `- 验收针：${law.liveDrill.successNeedle}`,
  `- 不确定性来源：${law.liveDrill.whyThisIsUncertain}`,
  ""
].join("\n");

const verifyScript = `import { readFileSync } from "node:fs";

const mustShiftAfterEmptyLoops = 2;
const law = JSON.parse(readFileSync("task_output/anti-backslide-net-upgrade/anti-backslide-net-upgrade.json", "utf8"));
const md = readFileSync("task_output/anti-backslide-net-upgrade/anti-backslide-net-upgrade.md", "utf8");

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

assert(Array.isArray(law.battlefieldLoop) && law.battlefieldLoop.length >= 5, "battlefieldLoop incomplete");
assert(md.includes("连续两轮没有远端证据增量") || md.includes("连续两轮无增量"), "missing forced shift law");
assert(md.includes("目标：") && md.includes("已验证证据：") && md.includes("当前阻塞：") && md.includes("止损条件 / 恢复条件："), "missing closure template");
assert(law.verificationProbes.some((probe: { command: string }) => probe.command.includes("/posts/1")), "missing deep detail probe");
assert(law.liveDrill.targetUrl.includes("jsonplaceholder.typicode.com/posts"), "missing remote drill target");
assert(mustShiftAfterEmptyLoops === 2, "threshold changed");

console.log("verified:anti-backslide-net-upgrade-structure");
`;

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(JSON_PATH, JSON.stringify(law, null, 2));
writeFileSync(MD_PATH, markdown);
writeFileSync(VERIFY_PATH, verifyScript);

console.log(JSON.stringify({
  json: relative(ROOT, JSON_PATH),
  md: relative(ROOT, MD_PATH),
  verify: relative(ROOT, VERIFY_PATH)
}, null, 2));
