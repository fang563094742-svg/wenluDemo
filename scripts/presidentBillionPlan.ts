#!/usr/bin/env tsx
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

interface PlanLayer {
  horizon: string;
  target: string;
  coreBattle: string;
  keyConstraint: string;
  weeklyCadence: string[];
}

interface BillionPlan {
  generatedAt: string;
  northStar: string;
  singleMainRoute: string;
  yearlyTargets: string[];
  layers: PlanLayer[];
  nonNegotiables: string[];
  dailyTemplate: string[];
  weeklyReview: string[];
  killRules: string[];
}

const ROOT = resolve('.');
const OUTPUT_DIR = resolve(ROOT, 'task_output', 'president-billion-plan');
const OUT_JSON = resolve(OUTPUT_DIR, 'president-billion-plan.json');
const OUT_MD = resolve(OUTPUT_DIR, '总统的亿万计划.md');

const report: BillionPlan = {
  generatedAt: new Date().toISOString(),
  northStar: '10年内形成可复制的高客单成交系统与自有分发体系，累计可验证收入跨过1000万。',
  singleMainRoute: '先用一个能稳定出单的高价值服务打穿现金流，再把成交、交付、复购、分发做成可复制系统，最后扩成多兵种工作室。',
  yearlyTargets: [
    '第1年：打穿一个高客单服务闭环，形成稳定案例、报价和复购链。',
    '第2-3年：把成交与交付拆成三人可协同执行的标准化工作室。',
    '第4-5年：把公开分发、内容获客、私域转化连成自有流量飞轮。',
    '第6-10年：扩展到多条高利润产品腿，保持现金流与品牌同时增长。'
  ],
  layers: [
    {
      horizon: '十年',
      target: '累计1000万级结果，不靠单次爆发，靠系统复利。',
      coreBattle: '建立自己的成交系统、交付系统、分发系统。',
      keyConstraint: '不能只靠零散接单，必须逐步摆脱对单点平台和单点个人体力的依赖。',
      weeklyCadence: [
        '每周固定复盘一次：哪条腿最接近钱，哪条腿该砍。',
        '每周至少沉淀一个可复用模板、脚本或判词。'
      ]
    },
    {
      horizon: '一年',
      target: '做出一个月月能成交的服务主线。',
      coreBattle: '高客单问题解决方案：能直接帮客户省时间、增收入、补短板。',
      keyConstraint: '不能被低价零工拖死；必须逐步抬高报价与门槛。',
      weeklyCadence: [
        '每周至少推进一个真实机会到报价或收款。',
        '每周至少新增一个成交证据或交付样本。'
      ]
    },
    {
      horizon: '季度',
      target: '固定一条主卖点、一条主渠道、一条主交付链。',
      coreBattle: '减少分散，避免什么都想做。',
      keyConstraint: '任何新方向都要通过“能否更快带来真实钱”筛选。',
      weeklyCadence: [
        '本季度只维护一个主打成交页。',
        '本季度只重点经营一到两个公开入口。'
      ]
    },
    {
      horizon: '本月',
      target: '把主外发、主报价、主收款、主交付四件套锁成唯一现行。',
      coreBattle: '消灭默认值漂移，减少每次开工前的犹豫。',
      keyConstraint: '不能再靠临场重写文案或临场决定报价。',
      weeklyCadence: [
        '周一锁本周主线。',
        '周三查外发回声与报价数。',
        '周五复盘进钱与阻塞。'
      ]
    },
    {
      horizon: '本周',
      target: '推进最接近现金的一条线，并留下可复用资产。',
      coreBattle: '外发、跟进、报价、收款。',
      keyConstraint: '忙碌不算推进；必须出现现实回声。',
      weeklyCadence: [
        '至少一次真实外发。',
        '至少一次报价。',
        '至少一次复盘并更新唯一现行卡。'
      ]
    },
    {
      horizon: '今天',
      target: '只打最接近收入的动作，不扩线。',
      coreBattle: '先完成一个明确动作，再总结。',
      keyConstraint: '不允许一边做一边不断改主航向。',
      weeklyCadence: [
        '先做唯一阻塞。',
        '做完再汇报。'
      ]
    }
  ],
  nonNegotiables: [
    '所有计划都必须服务现实进钱，不为写计划而写计划。',
    '默认只保留一条主航线，其他方向先降级为候选。',
    '所有现行计划必须落成单文件可检查入口。'
  ],
  dailyTemplate: [
    '先看唯一现行主线卡，确认今天唯一目标。',
    '先做最接近钱的一步。',
    '把新证据写回唯一现行卡。'
  ],
  weeklyReview: [
    '这周真实进钱、报价、咨询分别有多少？',
    '哪条动作最接近下周的结果？',
    '哪条忙碌动作该直接砍掉？'
  ],
  killRules: [
    '连续两周没有更接近钱的迹象的方向，降级。',
    '需要反复临场解释但无法标准化的服务，降级。',
    '只产生忙碌感、不带来报价或回声的动作，停掉。'
  ]
};

const markdown = `# 总统的亿万计划

- 生成时间：${report.generatedAt}
- 北极星：${report.northStar}
- 唯一主航线：${report.singleMainRoute}

## 年度靶
${report.yearlyTargets.map((item) => `- ${item}`).join('\n')}

## 时间结构
${report.layers
  .map(
    (layer) => `### ${layer.horizon}\n- 目标：${layer.target}\n- 主战场：${layer.coreBattle}\n- 关键约束：${layer.keyConstraint}\n${layer.weeklyCadence.map((item) => `- 节奏：${item}`).join('\n')}`
  )
  .join('\n\n')}

## 铁律
${report.nonNegotiables.map((item) => `- ${item}`).join('\n')}

## 今日模板
${report.dailyTemplate.map((item) => `- ${item}`).join('\n')}

## 周复盘
${report.weeklyReview.map((item) => `- ${item}`).join('\n')}

## 砍线规则
${report.killRules.map((item) => `- ${item}`).join('\n')}
`;

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });
  await writeFile(OUT_JSON, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(OUT_MD, `${markdown}\n`, 'utf8');
  console.log(JSON.stringify({ json: OUT_JSON, markdown: OUT_MD }, null, 2));
}

void main();
