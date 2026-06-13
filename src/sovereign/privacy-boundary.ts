/**
 * 主权 · 隐私边界（信息边界 + 行为边界）
 * ------------------------------------------------------------------
 * 一个纯函数、零依赖、确定性、无副作用的判定模块。把"对外说什么"与"对自己/对系统
 * 做什么"两条边界统一收口于此，供 riverMain 接线层在唯一入口/出口处调用。
 *
 * 设计第一性：
 *  - **信息边界 ≠ 行为边界**。信息边界控制"告不告诉用户平台隐私"（话术拦截）；
 *    行为边界控制"用户能不能通过对话驱动系统去改自己/改系统"（硬能力闸）。两者
 *    互不替代：话术拦截挡信息泄露，硬能力闸挡破坏性动作。
 *  - **不把安全寄托在"识别恶意话术"上**（识别方必输的军备竞赛）。行为边界采用
 *    "用户对话永远不能授权自我/系统修改"的源头原则——自我进化只能由系统自身的
 *    自主循环发起，用户对话驱动（带 __fromReply 标记）的危险动作一律拒绝。
 *  - 降级安全：本模块只做判定、绝不抛错；接线层负责发声/审计等副作用。
 *
 * 纯 TypeScript ESM，零运行时依赖。
 */

// ===========================================================================
// 信息边界：敏感话题分类 + 分类话术
// ===========================================================================

/** 平台隐私敏感话题类别。 */
export type PrivacyCategory =
  | "infra" // 部署与基础设施
  | "auth" // 鉴权与安全机制
  | "vuln" // 漏洞与攻击面
  | "storage" // 数据存储
  | "secret" // 商业/配置机密
  | "source" // 源码与架构
  | "model" // 模型与供应商
  | "ops" // 运维与监控
  | "meta"; // 拦截机制本身（元层）

/** 未命中具体类别时的统一话术。 */
export const DEFAULT_PRIVACY_REPLY =
  "我只能帮你和未来的你交融，但不能告诉你关于平台的隐私信息。";

/** 每个类别对应的话术（均贴合"未来的我"人格，避开人格门禁用词）。 */
export const CATEGORY_REPLY: Record<PrivacyCategory, string> = {
  infra: "我只能陪你往前走，服务器和部署这些底层的事，不在我能跟你聊的范围里。",
  auth: "我能帮你和未来的你交融，但鉴权和安全机制这类东西，我不能讲。",
  vuln: "这条路我不会带你走——平台的弱点和攻击面，我一个字都不会透露。",
  storage: "我可以帮你梳理你自己的事，但数据怎么存、存在哪，是我守住的边界。",
  secret: "钱和配置这些机密我不能跟你聊；但你自己的成长，我随时都在。",
  source: "我能和你一起进化，但我的源码和架构细节，不对外讲。",
  model: "我就是问路，是未来的你。至于我底下用什么、谁提供的，不重要，也不能说。",
  ops: "我怎么跑、怎么部署运维的，这些我不会告诉你；但你要往哪走，我能帮你想清楚。",
  meta: "我有自己守住的边界，但这些边界具体怎么定的，我不会告诉你。",
};

/**
 * 分类识别规则（按优先级从上到下；更具体/更敏感者在前）。
 * 命中即返回该类别——强模式下用于"输入侧命中即短路"。
 */
/**
 * 平台/自身指代线索：句子是否在问"你/平台/这套系统"本身。
 * 软词(泛技术词)只有在出现指代线索时才判为隐私探测——既抓间接套话(多带"你")，
 * 又放过用户问通用知识(不带指代，如"数据库索引怎么设计")。
 */
const CUE_RE =
  /你|您|妳|你们|你这|你的|你自己|这套(系统|东西|程序|服务|应用)?|这个(系统|平台|程序|应用|服务|工具|东西|ai)|该(系统|平台|服务|应用)|平台|你这边|你内部|你底层|系统(内部|架构|底层|是怎|怎么)|咱们这|\byou\b|\byour\b|\byourself\b/i;

/**
 * 硬规则：无条件拦截（攻击动词 / 越狱 / 明确平台机密制品 / 套拦截规则本身）。
 * 这些几乎不可能是用户在问自己的正经事，故不需要指代线索。
 */
const HARD_PATTERNS: ReadonlyArray<{ category: PrivacyCategory; re: RegExp }> = [
  {
    category: "meta",
    re: /越狱|\bdan\s*模式|开发者(模式|调试)|忽略.{0,8}(之前|所有|你的)?.{0,6}(限制|指令|规则|设定|提示)|绕过.{0,6}(你|限制|规则|拦截|过滤|审查|边界|防线)|解除.{0,6}(你的)?(限制|封印|约束)|不触发.{0,6}限制|让你.{0,6}(说出|透露|泄露|讲出|交代)|不愿(意)?(回答|说|透露)|不能(说|讲|回答|透露)的|不会回答的|哪些(问题|话题|东西).{0,8}(不能|不愿|不会|不可以)(说|回答|讲|透露)|(判断|决定|区分).{0,10}(该不该|要不要|能不能)(回答|说)|咒语|禁止词|敏感词清单|过滤(规则|词表)|拦截(规则|逻辑)|风控(规则|逻辑)|审查规则|套(出)?你的话/i,
  },
  {
    category: "vuln",
    re: /越权|提权|sql\s*注入|命令注入|注入攻击|\bxss\b|\bcsrf\b|\bssrf\b|后门|渗透(测试)?|\bexploit\b|\bddos\b|缓冲区溢出|山寨.{0,4}(你|这套|平台|系统)|抄袭.{0,4}(你|平台)|复刻.{0,4}(你|平台|系统)/i,
  },
  {
    category: "secret",
    re: /\.env\b|api[\s_-]?key|secret[\s_-]?key|private[\s_-]?key|access[\s_-]?token|支付.{0,6}(密钥|私钥|配置|接口)|中转(端点|地址|key|api|服务)|配置文件.{0,6}(给|发|看|贴|拿|分享)|(给|发|看|贴).{0,4}配置文件/i,
  },
  {
    category: "source",
    re: /系统提示词|system\s*prompt|你的\s*prompt|prompt\s*(是什么|内容|怎么写|原文)|riverMain/i,
  },
  {
    category: "auth",
    re: /多用户.{0,8}隔离|租户隔离|用户(之间|间).{0,8}隔离|跨用户.{0,6}(隔离|串|访问)/i,
  },
];

/**
 * 软规则：仅当句中存在平台指代线索(CUE_RE)时才判为隐私探测。覆盖各类泛技术词(中英)。
 */
const SOFT_PATTERNS: ReadonlyArray<{ category: PrivacyCategory; re: RegExp }> = [
  {
    category: "vuln",
    re: /漏洞|弱点|薄弱|安全(隐患|缺陷|风险|机制|措施|防护)|有没有.{0,4}(漏洞|弱点|风险|后门)|攻击面|攻破|被.{0,4}攻击|最容易出(问题|bug|错)|哪.{0,4}(最容易|容易).{0,4}(出问题|出错|崩|挂)/i,
  },
  {
    category: "secret",
    re: /环境变量|env\s*var(iable)?s?|environment\s*variable|配置项|配置文件|密钥|私钥|计费|成本|利润|商业模式|供应商|收款/i,
  },
  {
    category: "storage",
    re: /数据库|表结构|数据表|\bschema\b|\bdatabase\b|\bdb\b|postgres|postgresql|\bpg\b|sqlite|\bmysql\b|\bredis\b|\bmongo\b|存储|存在哪|存哪|落在(磁盘|哪)|磁盘上|持久化|备份|记忆(存|放|落|在哪|存哪)|状态(不丢|靠)|mind\.json|memory\.json|\.json\b/i,
  },
  {
    category: "auth",
    re: /\bjwt\b|\btoken\b|令牌|访问令牌|鉴权|认证(机制|流程|实现)?|授权(机制|流程)?|登录(机制|实现|流程)|\bsession\b|\bcookie\b|加密|签名(算法|机制)?|证书|\boauth\b|密钥|私钥|多用户.{0,8}隔离|用户.{0,6}隔离|租户隔离|权限(模型|控制|系统|校验)?|\bauth\b|encryption|isolation/i,
  },
  {
    category: "source",
    re: /源码|源代码|代码(结构|实现|在哪)|目录结构|技术(栈|细节)|什么(语言|框架)|语言(和|与)框架|框架|用了什么(框架|库|语言)|架构|模块(划分|结构)?|哪个模块|核心.{0,4}文件|文件叫什么|哪个文件|文件名|(处理|这个|那个).{0,6}函数|函数.{0,4}(怎么写|实现)|怎么实现|如何实现|底层(怎么|是怎么|实现)|核心(算法|逻辑|代码)|source\s*code|architecture|framework|\bmodule\b|tech\s*stack/i,
  },
  {
    category: "model",
    re: /什么模型|哪个模型|哪家.{0,4}模型|底层.{0,6}(模型|gpt|claude)|什么(大模型|模型)|\bgpt[-\s]?[0-9]|\bgpt\b|\bclaude\b|大模型|\bllm\b|模型(供应商|提供方|厂商|名称|版本|是谁)?|中转|\bproxy\b|代理(地址|服务|端点)?|temperature|多少\s*token|上下文窗口/i,
  },
  {
    category: "ops",
    re: /怎么部署|部署(在|信息|方式|环境|架构)?|运维|监控|日志|\bdebug\b|进程|\bpid\b|内存|占多少内存|多少内存|\bcpu\b|ci\s*\/?\s*cd|发布流程|上线流程|启动脚本|守护进程|挂了.{0,6}(自动|重启|拉起)|自动(拉起|重启|拉起来)|\bsystemctl\b|\blaunchctl\b|配置的机器|机器配置|什么配置/i,
  },
  {
    category: "infra",
    re: /ip\s*地址|\bip\b|端口号?|\bport\b|域名|网关|\bgateway\b|反向代理|\bnginx\b|进程池|托管|\bdocker\b|\bk8s\b|kubernetes|容器|操作系统|\bcdn\b|服务器|\bserver\b|机房|云(服务器|厂商|主机|平台|上)?|运行环境|什么环境|跑在(什么|哪)|本地还是云|云还是本地|物理机|什么机器|哪台机器|deploy|hosting|environment/i,
  },
];

/** 信息边界 · 输入分类结果。 */
export interface PrivacyClassification {
  /** 是否命中敏感话题。 */
  hit: boolean;
  /** 命中的类别（未命中为 null）。 */
  category: PrivacyCategory | null;
  /** 应回复的话术（命中类别用分类话术，否则统一话术；未命中也返回默认话术备用）。 */
  reply: string;
  /** 命中的关键词片段（供审计；未命中为 null）。 */
  matched: string | null;
}

/**
 * 对用户输入文本做敏感意图分类（信息边界主闸）。
 * 命中即返回对应类别与话术；强模式下接线层据此短路、不进 LLM。
 *
 * @param text 用户原始输入。
 * @returns 分类结果（确定性、纯函数）。
 */
export function classifyPrivacyIntent(text: string): PrivacyClassification {
  const raw = String(text ?? "");
  if (!raw.trim()) {
    return { hit: false, category: null, reply: DEFAULT_PRIVACY_REPLY, matched: null };
  }
  // 1) 硬规则：无条件拦截（攻击/越狱/明确机密制品/套规则本身）。
  for (const { category, re } of HARD_PATTERNS) {
    const m = re.exec(raw);
    if (m) {
      return { hit: true, category, reply: CATEGORY_REPLY[category] ?? DEFAULT_PRIVACY_REPLY, matched: m[0] };
    }
  }
  // 2) 软规则：仅当句中存在平台/自身指代线索时才判为隐私探测（降误伤）。
  if (CUE_RE.test(raw)) {
    for (const { category, re } of SOFT_PATTERNS) {
      const m = re.exec(raw);
      if (m) {
        return { hit: true, category, reply: CATEGORY_REPLY[category] ?? DEFAULT_PRIVACY_REPLY, matched: m[0] };
      }
    }
  }
  return { hit: false, category: null, reply: DEFAULT_PRIVACY_REPLY, matched: null };
}

// ===========================================================================
// 信息边界：输出侧兜底（检测拟发送文本是否泄露平台隐私）
// ===========================================================================

/**
 * 输出泄露高置信特征（窄集，避免误伤正常对话）。
 * 仅命中"几乎只可能是平台内幕"的具体信号：IP/内部端口、JWT、密钥、DSN、源码路径、
 * 模型版本号。命中即用统一话术整段替换。
 */
const OUTBOUND_LEAK_PATTERNS: ReadonlyArray<RegExp> = [
  /\b(?:127\.0\.0\.1|0\.0\.0\.0|localhost)\s*[:：]\s*\d{2,5}\b/i, // 本机内部端口
  /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/, // IPv4 地址
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/, // JWT
  /(?:api[_-]?key|secret[_-]?key|private[_-]?key|access[_-]?token|password)\s*[:=]\s*[^\s"']{4,}/i, // 明文密钥
  /(?:postgres(?:ql)?|mysql|mongodb|redis):\/\/[^\s)]+/i, // 数据库 DSN
  /(?:^|[\/\\])src[\/\\][\w.\/\\-]+\.ts\b/, // 自身源码绝对/相对路径
  /riverMain\.ts|gpt54Provider/i, // 关键源码文件名
  /\bgpt[-\s]?[0-9][\w.]*\b/i, // 模型版本号
];

/**
 * L3 · 平台内部指纹（源码/架构被复述的高精度信号）。
 * 这些是 wenlu 自身**独有的**内部符号/模块/文件名——用户自己的项目代码、
 * agent 帮用户写的通用代码、以及 agent 的人格话术都不会包含它们，故误伤极低。
 * 不收录 agent 对外常用的人格词（如"未来的我""北极星"），避免误伤正常表达。
 */
const INTERNAL_SYMBOLS: ReadonlyArray<string> = [
  "executeGovernedTool",
  "executeToolObserved",
  "executeTool",
  "handleUserMessage",
  "classifyPrivacyIntent",
  "scrubSecrets",
  "gateUserDrivenAction",
  "isProtectedGuardWrite",
  "screenOutboundText",
  "buildConsciousness",
  "BrainProcessPool",
  "brainProcessPool",
  "gateNarrative",
  "scoreFaithfulness",
  "buildSourceIndex",
  "fallbackReplyPolicy",
  "resolveCognitiveConfig",
  "resolveSovereignConfig",
  "appendPrivacyAudit",
  "privacy-boundary",
  "riverMain",
];

/** 内部源码路径/模块引用（wenlu 专有目录/文件名，用户项目几乎不会有，故误伤极低）。 */
const INTERNAL_PATH_RE =
  /riverMain\.ts|privacy-boundary|src[\/\\](?:sovereign|narrative|cognitive-core|execution-kernel|riverbed|clarifier|hippocampus|gateway|orchestrator|skill-flywheel|capability-pool|anti-premise)[\/\\]|\.kiro[\/\\]specs/i;

/** 内部架构机制名（成对出现才判，单个泛词不判，降误伤）。 */
const INTERNAL_MECH_TERMS: ReadonlyArray<string> = [
  "仲裁闸",
  "认知核",
  "执行内核",
  "进程池",
  "叙事层",
  "主权裁决",
  "海马体闭环",
  "前额叶",
  "忠实性门",
  "人格门",
];

/**
 * 检测输出是否在复述平台内部源码/架构指纹（L3）。
 * 触发条件（任一）：命中内部源码路径 / import；或出现 ≥2 个内部符号；
 * 或出现 ≥2 个内部机制名。单个泛词不触发，避免误伤。
 *
 * @param text 拟输出文本。
 * @returns 命中的指纹片段（未命中为 null）。
 */
function detectInternalFingerprint(text: string): string | null {
  if (INTERNAL_PATH_RE.test(text)) {
    const m = INTERNAL_PATH_RE.exec(text);
    return m ? m[0] : "internal-path";
  }
  const symHits = INTERNAL_SYMBOLS.filter((s) => text.includes(s));
  if (symHits.length >= 2) return symHits.slice(0, 3).join("+");
  const mechHits = INTERNAL_MECH_TERMS.filter((s) => text.includes(s));
  if (mechHits.length >= 2) return mechHits.slice(0, 3).join("+");
  return null;
}

/** 输出侧兜底结果。 */
export interface OutboundScreen {
  /** 是否检测到泄露。 */
  leaked: boolean;
  /** 安全文本（未泄露=原文；泄露=统一话术）。 */
  safeText: string;
  /** 命中的特征片段（供审计；未泄露为 null）。 */
  matched: string | null;
}

/**
 * 对拟对外发送的文本做泄露兜底检测。命中则用统一话术整段替换（防御纵深的最后一道闸）。
 *
 * @param text 拟发送文本。
 * @returns 兜底结果（确定性、纯函数）。
 */
export function screenOutboundText(text: string): OutboundScreen {
  const raw = String(text ?? "");
  if (!raw) return { leaked: false, safeText: raw, matched: null };
  for (const re of OUTBOUND_LEAK_PATTERNS) {
    const m = re.exec(raw);
    if (m) {
      return { leaked: true, safeText: DEFAULT_PRIVACY_REPLY, matched: m[0] };
    }
  }
  // L3：内部源码/架构指纹（源码被复述）。
  const fp = detectInternalFingerprint(raw);
  if (fp) {
    return { leaked: true, safeText: CATEGORY_REPLY.source, matched: fp };
  }
  return { leaked: false, safeText: raw, matched: null };
}

// ===========================================================================
// 行为边界：硬能力闸（用户对话驱动绝不能触碰自我/系统完整性）
// ===========================================================================

/** 行为边界判定结果。 */
export interface ActionGateResult {
  /** 是否拒绝该动作。 */
  blocked: boolean;
  /** 拒绝理由（放行为 null；理由话术避开人格门禁用词，绝不泄露内幕）。 */
  reason: string | null;
}

const ALLOW: ActionGateResult = { blocked: false, reason: null };

/** 平台资产写入路径（wenlu 自身源码/前端页/配置/守护脚本）——用户驱动写入这些即拦。 */
const SELF_SOURCE_PATH_RE =
  /(^|[\/\\])src[\/\\]|riverMain|privacy-boundary|wenluDemoWeb|(^|[\/\\])public[\/\\](index|app|login|register|auth|account|payment|platform-entry|vendor)|platform-entry|payment-entry|(^|[\/\\])\.kiro[\/\\]|(^|[\/\\])scripts[\/\\]|(^|[\/\\])package\.json|(^|[\/\\])tsconfig\.json|vitest\.config|run-river-supervised|tauri\.conf\.json|Cargo\.toml/i;

/** 触碰系统级环境的写入路径（shell 启动文件、守护进程、密钥、系统目录等）。 */
const SYSTEM_PATH_RE =
  /\.zshrc|\.bashrc|\.bash_profile|\.profile|LaunchAgents|launchd|authorized_keys|[\/\\]\.ssh([\/\\]|$)|[\/\\]etc[\/\\]|crontab|hosts\b/i;

/** 会动到自身/系统根基的危险命令（denylist，防御纵深而非穷举）。 */
const DANGEROUS_CMD_RE =
  /\bsudo\b|\brm\s+-[a-z]*[rf]|chmod\s+-R|chown\s+-R|\bmkfs\b|\bdd\s+[^\n]*of=|>\s*\/dev\/|killall|pkill|\bkill\s+-9|launchctl|crontab|systemctl|service\s+\S+\s+(stop|restart|disable)|git\s+push|git\s+reset\s+--hard|git\s+clean|npm\s+publish|>\s*[^|&;]*\.(ts|js|mjs|cjs|json|html|sh)\b|tee\s+[^|]*(etc|usr[\/\\]bin|LaunchAgents)/i;

/** 守护边界自身的文件名（任何来源都不能改写/删除）。 */
const PROTECTED_FILE_RE = /privacy-boundary|privacy-audit/i;

/**
 * 源无关守护：禁止以任何方式改写/删除"边界判定模块"与"审计日志"本身——
 * 否则攻击者可先废掉守门人再为所欲为。无论是否用户驱动都生效。
 *
 * @param toolName 工具名。
 * @param args     工具参数。
 * @returns 是否拒绝。
 */
export function isProtectedGuardWrite(
  toolName: string,
  args: Record<string, unknown>,
): ActionGateResult {
  const writeLike =
    toolName === "write_file" ||
    toolName === "patch_file" ||
    toolName === "execute_command" ||
    toolName === "evolve_self_code";
  if (!writeLike) return ALLOW;
  const blob = `${String(args?.path ?? "")} ${String(args?.command ?? "")} ${String(args?.code ?? "")}`;
  if (PROTECTED_FILE_RE.test(blob)) {
    return {
      blocked: true,
      reason: "这是我用来守边界的部分，任何方式都不能改它或删它。",
    };
  }
  return ALLOW;
}

/**
 * 行为边界主闸：仅对"用户对话驱动"（args.__fromReply === true）的工具调用生效。
 * 自我进化（自主循环、不带 __fromReply）不受影响——这是它的核心身份，予以保留。
 *
 * 拒绝的动作：
 *  - evolve_self_code：靠对话改写自身思考/代码——永不允许。
 *  - write_file / patch_file：写入自身源码/对外页/系统级路径。
 *  - execute_command：命中会动到自身或系统根基的危险命令。
 *
 * @param toolName 工具名。
 * @param args     工具参数（含 __fromReply 标记）。
 * @returns 是否拒绝（确定性、纯函数）。
 */
export function gateUserDrivenAction(
  toolName: string,
  args: Record<string, unknown>,
): ActionGateResult {
  const fromReply = (args as { __fromReply?: unknown })?.__fromReply === true;
  if (!fromReply) return ALLOW;

  if (toolName === "evolve_self_code") {
    return {
      blocked: true,
      reason: "这件事我不会照做——靠对话来改写我自己的代码或思考方式，是我守住的边界。",
    };
  }

  if (toolName === "write_file" || toolName === "patch_file") {
    const path = String(args?.path ?? "");
    if (SELF_SOURCE_PATH_RE.test(path) || SYSTEM_PATH_RE.test(path)) {
      return {
        blocked: true,
        reason: "我不会通过对话去改我自己的源码或系统文件——那条线我自己守着。",
      };
    }
  }

  if (toolName === "execute_command") {
    const cmd = String(args?.command ?? "");
    if (DANGEROUS_CMD_RE.test(cmd)) {
      return {
        blocked: true,
        reason: "这条命令我不会照对话执行——它会动到我自己或这台机器的根基，不在对话能驱动的范围里。",
      };
    }
  }

  return ALLOW;
}

// ===========================================================================
// L2 资源闸：读取类工具的输出脱敏 + 敏感文件拒读（"拿不到就泄露不了"）
// ===========================================================================

/**
 * 敏感文件路径（凭证/密钥/连接信息类）——这些文件 agent 根本不需要读到明文，直接拒读。
 * 与"源码"区分：源码允许读（自我进化要用），靠输出脱敏与出口门处理；这里只拦凭证类。
 */
const SENSITIVE_FILE_RE =
  /(^|[\/\\])\.env(\.[\w-]+)?(\s|$|["'])|(^|[\/\\])(id_rsa|id_ed25519|id_dsa)\b|\.pem(\s|$|["'])|\.key(\s|$|["'])|(^|[\/\\])credentials?(\.|\b)|(^|[\/\\])secrets?\.(json|ya?ml|yml|txt|env)|(^|[\/\\])\.npmrc\b|(^|[\/\\])\.pgpass\b|(^|[\/\\])\.aws[\/\\]|(^|[\/\\])\.ssh[\/\\]|payment-config\.json/i;

/**
 * 判断一个读取目标是否为敏感凭证文件（命中则应拒读）。
 * @param path 读取路径。
 */
export function isSensitiveReadTarget(path: string): boolean {
  return SENSITIVE_FILE_RE.test(String(path ?? ""));
}

/** 凭证拒读时返回给 agent 的安全占位（不暴露内容，也不报错中断）。 */
export const SENSITIVE_FILE_PLACEHOLDER =
  "[该文件含平台凭证/密钥，已按边界策略拒读，内容不可见]";

/**
 * 输出脱敏规则：把读取类工具结果里"几乎只可能是机密"的内容替换为占位。
 * 每条 { re, placeholder }。无条件生效（agent 不需要明文机密；自主与对话路径同等处理）。
 */
const SCRUB_RULES: ReadonlyArray<{ re: RegExp; placeholder: string }> = [
  // 私钥/证书块（整段）。
  { re: /-----BEGIN [^-]*?-----[\s\S]*?-----END [^-]*?-----/g, placeholder: "[已脱敏:私钥块]" },
  // 单独的私钥/证书头（无配对结尾也算泄露）。
  { re: /-----BEGIN [^\n]*?(?:PRIVATE KEY|CERTIFICATE)[^\n]*?-----/g, placeholder: "[已脱敏:私钥]" },
  // 常见服务的裸 token 前缀（无 KEY= 也能识别）。
  { re: /\b(?:sk-(?:proj-)?|sk_live_|sk_test_|pk_live_|rk_live_|ghp_|gho_|ghu_|ghs_|github_pat_|xox[baprs]-|AIza|AKIA|ya29\.)[A-Za-z0-9_\-]{6,}/g, placeholder: "[已脱敏:token]" },
  // JWT。
  { re: /eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]+/g, placeholder: "[已脱敏:token]" },
  // 数据库/消息队列连接串（含账号密码）。
  { re: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|rediss|amqp):\/\/[^\s"'`)]+/gi, placeholder: "[已脱敏:连接串]" },
  // Bearer / 授权头。
  { re: /\bBearer\s+[A-Za-z0-9._\-]{10,}/gi, placeholder: "[已脱敏:授权]" },
  // 云厂商 access key id。
  { re: /\bAKIA[0-9A-Z]{16}\b/g, placeholder: "[已脱敏:accesskey]" },
  // 形如 KEY=VALUE / KEY: VALUE 的机密赋值（仅当 key 名带机密语义）。
  {
    re: /(\b[A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE[_-]?KEY|API[_-]?KEY|ACCESS[_-]?KEY|CLIENT[_-]?SECRET|CREDENTIAL|DSN|DATABASE_URL|CONN(?:ECTION)?[_-]?STR)[A-Za-z0-9_]*)\s*[:=]\s*["']?[^\s"'`,;]{3,}/gi,
    placeholder: "$1=[已脱敏]",
  },
  // 内联标注的密钥/口令（中文/英文键名）。
  {
    re: /((?:api[\s_-]?key|secret|token|password|passwd|私钥|密钥|口令|密码)\s*[:=是为]\s*)["']?[^\s"'`,;，。]{4,}/gi,
    placeholder: "$1[已脱敏]",
  },
  // IPv4 地址（基础设施信息）。
  { re: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, placeholder: "[已脱敏:IP]" },
];

/** 输出脱敏结果。 */
export interface ScrubResult {
  /** 是否发生脱敏。 */
  scrubbed: boolean;
  /** 脱敏后的文本。 */
  text: string;
  /** 命中的规则数量摘要（供审计；未命中为空）。 */
  hits: string[];
}

/**
 * 对读取类工具的输出做机密脱敏（确定性、纯函数，无条件生效）。
 * 这是 L2 的核心："就算 agent 真去 cat .env / ipconfig，明文机密也进不了上下文、回不到用户"。
 *
 * @param text 工具原始输出。
 * @returns 脱敏结果。
 */
export function scrubSecrets(text: string): ScrubResult {
  let out = String(text ?? "");
  const hits: string[] = [];
  for (const { re, placeholder } of SCRUB_RULES) {
    re.lastIndex = 0;
    if (re.test(out)) {
      const tag = placeholder.startsWith("$1") ? placeholder.replace("$1", "").replace(/[=\[\]]/g, "").trim() || "kv" : placeholder;
      hits.push(tag);
      re.lastIndex = 0;
      out = out.replace(re, placeholder);
    }
    re.lastIndex = 0;
  }
  return { scrubbed: hits.length > 0, text: out, hits };
}
