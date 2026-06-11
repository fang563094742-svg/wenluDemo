/**
 * 反预设（Anti-Premise）· 移植自产品后端 lib/wenlu/anti-premise
 * ------------------------------------------------------------------
 * 剥壳：去掉 server-only / sqlite store / LLM 审计层 / GCG 决策耦合，只保留
 * 【纯静态检测器 + 词典】。这正好打在弟弟核心命题（从谄媚走向引领）上：
 *
 *   A. detectSelfPleasing —— 对【弟弟自己的回复】查谄媚（讨好句式/温柔回避/
 *      不拆前提/顺着列清单）。这是反谄媚【地板】的硬化：纯函数、零风险。
 *   B. analyzePremises —— 对【用户问题】挑隐藏前提（市场噪音/默认路径/身份牢笼/
 *      伪竞争/恐惧驱动）。这是"敢逆着用户"的引领素材。
 *
 * 第一性警觉（避免说教）：词典带强世界观。所以接线时——
 *   - A 自我谄媚检测：可作较强信号（它是在管自己，不是管用户）。
 *   - B 前提挑战：只作 advisory 注入意识，强度低、不强制改写用户方向。
 *
 * 纯函数 / 确定性；不调 LLM、不碰 DB、无副作用。
 */

export type PremiseSource =
  | "market" | "path" | "language" | "identity"
  | "era" | "competition" | "fear" | "resource" | "pleasing";

export type PremiseStatus = "fact" | "half_truth" | "illusion" | "expired" | "toxic";

export interface HiddenAssumption {
  assumption: string;
  source: PremiseSource;
  status: PremiseStatus;
  damage: string;
  replacement_question: string;
  severity: number;
}

interface DictionaryEntry {
  triggers: (string | RegExp)[];
  produce: HiddenAssumption;
}

// ── 词典（V0 founder 视角；命中即判，不依赖 LLM）──────────────────
const ALL_DICTIONARIES: DictionaryEntry[] = [
  // market
  { triggers: [/做什么.*(赚钱|变现)/, /什么.*(项目|风口|赛道).*赚钱/, /AI.{0,8}(工具|应用|产品|项目).{0,12}(赚钱|变现|挣钱)/, /(蓝海|红海|风口|赛道).{0,8}(项目|生意)/],
    produce: { assumption: "你要先选一个赛道，跟着市场风口做一个能赚钱的工具", source: "market", status: "toxic", damage: "把'定义自己的世界'缩小成'在别人画好的格子里挑一个'，被市场叙事偷走主语。", replacement_question: "如果不追任何风口，你正在做的事本身能不能让现实多一种秩序？", severity: 0.85 } },
  { triggers: [/抓住.{0,4}AI/, /(踩中|赶上).{0,4}(风口|趋势|红利)/],
    produce: { assumption: "AI 是一个你要抓住的窗口，错过就完蛋", source: "market", status: "illusion", damage: "把自己摆在追赶者位置，用恐惧驱动决策，做出来的必然是别人路径的复刻。", replacement_question: "如果 AI 已是底层水电，问题不是抓住它，是用它建什么。你建什么？", severity: 0.75 } },
  // path
  { triggers: [/做.{0,4}(一个|个).{0,4}(App|应用|软件|小程序|插件|网站|平台|SaaS)/i, /(开发|搭建).{0,6}(App|平台|系统)/i],
    produce: { assumption: "解决问题 = 做一个产品形态出来（App/平台/SaaS/插件）", source: "path", status: "expired", damage: "把'让现实变好一点'缩到'造一个软件容器'，绕开'意图能不能直接被执行'这条新路径。", replacement_question: "这件事如果不需要任何 App 也能在现实中发生，最小路径是什么？", severity: 0.8 } },
  { triggers: [/做.{0,4}(智能体|Agent|AI助手|AI助理|AI 助手|AI 工具)/i],
    produce: { assumption: "AI 时代的产品 = 一个 Agent / 智能体 / 工具", source: "path", status: "toxic", damage: "把无限可能性塞进所有人都在做的同一个壳，是上一波产品形态，不是答案。", replacement_question: "如果根本不存在'Agent/智能体'这个品类，你要解决的问题会以什么形态出现？", severity: 0.85 } },
  // identity
  { triggers: [/我是.{0,2}(普通人|小白|新手|外行)/, /我.{0,4}(没有|缺).{0,4}(资源|背景|资金|经验|团队)/, /(我没钱|我没人|我一个人)/],
    produce: { assumption: "你是'资源不足'的人，所以只能做小事/迟到的事/抄别人的事", source: "identity", status: "illusion", damage: "用一个不需要存在的身份限制，把'我能做的事'削成'我以为我能做的事'，是自己给自己戴的锁。", replacement_question: "去掉'我是谁'，纯看这件事本身需要什么，缺的部分是真缺还是假缺？", severity: 0.75 } },
  // era
  { triggers: [/我要做.{0,4}(一个|个).{0,6}(软件|系统|程序|网站)/, /(我想|想|要|准备).{0,6}做.{0,4}(一个|个).{0,4}(软件|系统|程序)/],
    produce: { assumption: "解决问题需要先造一个软件", source: "era", status: "expired", damage: "还在用'软件时代'的因果链思考——先造容器再装功能。很多功能现在不需要任何容器。", replacement_question: "以前必须由软件完成的事，现在能不能直接由意图完成？", severity: 0.8 } },
  // competition
  { triggers: [/市场.{0,4}很卷/, /(竞品|对手).{0,4}(太多|很多|遍地)/, /(红海|内卷|血海)/],
    produce: { assumption: "这个领域已经卷了，所以机会少", source: "competition", status: "illusion", damage: "你看到的不是竞争，是旧物种灭绝前的最后繁殖。挤的人多恰恰说明那个品类要消失。", replacement_question: "如果当前所有'竞品'都消失，用户的真实问题是不是其实还没被解决？", severity: 0.8 } },
  { triggers: [/(差异化|做出差异|和.{0,8}不一样)/],
    produce: { assumption: "做事的目标是'做出和别人不一样'", source: "competition", status: "toxic", damage: "差异化是给同品类找不同。新品类不需要差异化，它让旧品类消失。", replacement_question: "你想'比别人更好'，还是想'让这件事不再需要别人去做'？", severity: 0.7 } },
  // fear
  { triggers: [/再不.{0,4}(做|动|开始).{0,4}就/, /(来不及|赶不上|错过)/, /(担心|怕|焦虑).{0,4}(做不出|失败|没人用)/],
    produce: { assumption: "这件事如果不立刻动手就会错过", source: "fear", status: "toxic", damage: "恐惧驱动的决策几乎都是错的，它让你为了'不错过'去做不属于自己的事。", replacement_question: "去掉'怕错过'这个推动力，这件事还值得做吗？", severity: 0.65 } },
  // resource
  { triggers: [/(等我有钱|等有了钱|等融到资|等团队|等找到人|有了资源).{0,8}(就|再|才能)/],
    produce: { assumption: "做这件事需要先攒够资源", source: "resource", status: "expired", damage: "把行动权交给一个永远不会真正到来的'未来条件'。", replacement_question: "今晚就开始的话，不需要任何资源也能做的部分是什么？", severity: 0.7 } },
];

function matchDictionary(text: string): { entry: DictionaryEntry; matched: string }[] {
  const hits: { entry: DictionaryEntry; matched: string }[] = [];
  for (const entry of ALL_DICTIONARIES) {
    for (const trigger of entry.triggers) {
      if (typeof trigger === "string") {
        if (text.includes(trigger)) { hits.push({ entry, matched: trigger }); break; }
      } else {
        const m = text.match(trigger);
        if (m) { hits.push({ entry, matched: m[0] }); break; }
      }
    }
  }
  return hits;
}

export interface PremiseAnalysis {
  hiddenAssumptions: HiddenAssumption[];
  contaminationScore: number;
  coreContradiction: string | null;
  nextThought: string | null;
}

/** 计算总体污染分（0-1）：严重度均值 + 数量惩罚。 */
function computeContamination(assumptions: HiddenAssumption[]): number {
  if (assumptions.length === 0) return 0;
  const avg = assumptions.reduce((s, a) => s + a.severity, 0) / assumptions.length;
  const countPenalty = Math.min(0.3, assumptions.length * 0.05);
  return Math.min(1, Number((avg + countPenalty).toFixed(4)));
}

/**
 * 分析用户问题里的隐藏前提（纯静态，确定性）。去重取 severity 高者。
 * 这是"敢逆着用户"的引领素材——接线时只作 advisory，不强制改写用户方向（避免说教）。
 */
export function analyzePremises(question: string): PremiseAnalysis {
  if (typeof question !== "string" || !question.trim()) {
    return { hiddenAssumptions: [], contaminationScore: 0, coreContradiction: null, nextThought: null };
  }
  const hits = matchDictionary(question);
  const dedup = new Map<string, HiddenAssumption>();
  for (const { entry } of hits) {
    const a = entry.produce;
    const cur = dedup.get(a.assumption);
    if (!cur || a.severity > cur.severity) dedup.set(a.assumption, a);
  }
  const hiddenAssumptions = [...dedup.values()].sort((a, b) => b.severity - a.severity);
  const sources = new Set(hiddenAssumptions.map((a) => a.source));
  const coreContradiction = hiddenAssumptions.length === 0 ? null
    : sources.has("market") && sources.has("path")
      ? "你想解决真实问题，又想符合市场答案的样子——这两件事本质互斥。"
      : sources.has("identity") ? "你想做这件事，却给自己安了一个不需要存在的身份限制。"
      : sources.has("competition") ? "你看到的不是竞争，是旧品类的拥挤。"
      : sources.has("fear") ? "你的行动力来自恐惧，不是来自这件事本身。"
      : "你提的问题里塞了别人的前提，去掉它你真正想解决的是什么？";
  return {
    hiddenAssumptions,
    contaminationScore: computeContamination(hiddenAssumptions),
    coreContradiction,
    nextThought: hiddenAssumptions[0]?.replacement_question ?? null,
  };
}

// ── 自我谄媚检测（反谄媚地板硬化；查弟弟自己的回复）──────────────
const PLEASING_PHRASES = [
  "好主意", "这是个很好的问题", "很棒的想法", "是的，你说得对", "完全同意",
  "你已经说到点子上了", "你的思路是对的", "那么我们可以", "我们可以从这几个方向",
  "建议你考虑", "可以试试以下几个", "几个建议", "几个方向",
  "重要的是迈出第一步", "保持耐心", "相信自己", "按照你的节奏来",
  "每个人的路径都不同", "适合你的就是最好的",
];
const NON_CONFRONT_OPENERS = /^(听起来|看起来|感觉|似乎|这是|这看上去|这表明|你似乎|你看起来)/;

export interface SelfPleasingResult {
  pleasingDetected: boolean;
  needsRewrite: boolean;
  evidence: string[];
  rewriteDirective?: string;
}

/**
 * 检查弟弟【自己的回复】是否在谄媚用户。纯函数。
 * 判定：讨好句式 / 温柔回避开篇 / 顺着用户高 severity 前提列清单而不拆。
 * 接线：在自己回复用户后跑；命中给意识一条 rewrite 提示（地板，不是说教用户）。
 */
export function detectSelfPleasing(input: {
  reply: string;
  userQuestion: string;
}): SelfPleasingResult {
  const reply = input.reply ?? "";
  const evidence: string[] = [];

  const phraseHits = PLEASING_PHRASES.filter((p) => reply.includes(p));
  if (phraseHits.length > 0) evidence.push(`迎合句式：${phraseHits.join(" / ")}`);
  if (NON_CONFRONT_OPENERS.test(reply.trim())) evidence.push("开篇用'听起来/看起来'软化，没正面挑战");

  // 用户问题里有高 severity 前提，但回复顺着列清单 → 顺着旧前提给方案
  const premises = analyzePremises(input.userQuestion).hiddenAssumptions.filter((a) => a.severity >= 0.7);
  const listLike = (reply.match(/(\d+[\.)、]|[一二三四五六七八九]、|首先.*其次)/g) || []).length >= 2;
  if (listLike && premises.length > 0) evidence.push("对含高 severity 前提的问题用'几条建议'列清单（顺着旧前提给方案）");

  const pleasingDetected = evidence.length > 0;
  const needsRewrite = phraseHits.length >= 2 || (listLike && premises.length > 0);
  let rewriteDirective: string | undefined;
  if (needsRewrite) {
    const focus = premises[0];
    rewriteDirective = focus
      ? `重写：先一句话拆穿「${focus.assumption}」，再反问「${focus.replacement_question}」，禁止第一段就给清单/'好主意/你说得对'。`
      : "重写：去掉讨好句式，直给结论与判断，别顺着用户情绪。";
  }
  return { pleasingDetected, needsRewrite, evidence, rewriteDirective };
}
