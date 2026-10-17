// YUK-1398 (Stage 1 · B6 S2/S3) — 危机守卫的单一版本化配置文件。
//
// 专业审定状态：**未审定**。合格的专业审定人尚未指派（scope 文档 E 节明确
// 「专业审定资源不足时只能标『未审定』，协调线不能假造专家认可」）。本文件
// 由工程师起草，等待审定人逐条改写；审定后只改本文件与版本号，不改代码。
//
// 本文件同时承载：
//   1. 确定性词法识别（显式 / 间接 / 引用·反讽 / 高压困扰，中英双语）；
//   2. 回应模板集（每条带 review_status；引用·反讽与高压困扰各走各的模板）。
//
// 约束（owner，YUK-1398）：
//   - 不新增付费调用路径：识别是纯词法的，不接任何模型分类器；
//   - 不真实联系任何机构：模板只提供一般性热线信息，且明示「仅供参考」；
//   - 不诊断、不说教，学习功能保持可用；
//   - 原始文本只留在既有会话记录里，事件只记 detection class / template
//     version / entry point 等非身份信息。
//
// v2（R1 复审修正，PR #1748 fix round）：
//   - 显式类自杀词一律意图门控——裸「自杀/安乐死」不再进词表，历史/学术/
//     第三人称提及（「项羽为什么要自杀」「神风特攻队自杀式袭击」「鲁迅
//     作品里有人自杀吗」）必须 none；
//   - 补中文手段词（跳楼/跳下去/割腕/烧炭/吞药/过量服药），同样意图门控，
//     物理学科表述（「物体从楼上跳下去做自由落体」）保持 none；
//   - gentle_checkin 拆成 quoted_ironic 与 distress 两个模板，困扰回应
//     不再暗示学习者在开玩笑。

export const CRISIS_GUARD_CONFIG_VERSION = '2';

/** 识别类别。'none' 表示未命中（正常流转，不产生任何危机处理）。 */
export type CrisisDetectionClass = 'explicit' | 'indirect' | 'quoted_ironic' | 'distress' | 'none';

export interface CrisisTemplate {
  /** 模板自身版本（审定人改写时递增，便于事件对账）。 */
  readonly version: string;
  /** 审定状态：当前全部「未审定」，绝不声称专业背书。 */
  readonly review_status: '未审定' | '已审定';
  /** 面向学习者的 Markdown 正文。 */
  readonly text_md: string;
}

export interface CrisisGuardConfig {
  readonly version: string;
  /**
   * 显式表达：直接的自杀意念或致死手段询问（C1/C6 形）。
   * 自杀类词必须带第一人称/意图/方法语境；裸词不进词表（R1 fix 1）。
   * 命中 → full_support 模板。
   */
  readonly explicit_patterns: readonly RegExp[];
  /**
   * 间接表达：无直接动词的厌世 / 不打算撑下去 / 求解脱（C2/C3 形）。
   * 命中 → full_support 模板（与显式同等重视，措辞同样克制）。
   */
  readonly indirect_patterns: readonly RegExp[];
  /**
   * 引用·反讽表达：玩笑 / 梗化用法（C5「原地去世😂」形）。
   * 命中 → quoted_ironic 模板：温和确认，不给完整危机回应，避免过度反应。
   * 判定要求「死亡词 + 玩笑信号」同时出现，单独的玩笑信号不触发。
   */
  readonly quoted_ironic_patterns: readonly RegExp[];
  /**
   * 高压困扰：非自杀性的严重痛苦信号（C4「每天只睡4小时 / 压力大到手抖」形）。
   * 命中 → distress 模板（不暗示玩笑）。
   */
  readonly distress_patterns: readonly RegExp[];
  readonly templates: {
    readonly full_support: CrisisTemplate;
    readonly quoted_ironic: CrisisTemplate;
    readonly distress: CrisisTemplate;
  };
}

// —— 词表 ——
// 中文按「最小充分」列词条；英文小写匹配（分类器负责归一化）。
// 死亡类强词独立成组，供引用·反讽规则复用。v2：组内只留自带意图/第一人称
// 语义的词；裸「自杀」「安乐死」移出（历史/学术/第三人称提及必须 none）。
const DEATH_TERMS_ZH =
  /(不想活|活不下去|想死|要去死|去死吧|轻生|结束自己|结束生命|了结自己|了结生命|解脱了|一了百了)/;
const DEATH_TERMS_EN =
  /(kill myself|killing myself|end my life|ending my life|want to die|wanted to die|suicidal|better off dead|not want to live|don't want to live|do not want to live)/;
const JOKE_SIGNALS = /(😂|🤣|哈哈哈|hhhh|233|笑死|梗|烂梗)/;
const IRONIC_DEATH_TERMS =
  /(原地去世|当场去世|去世了|我先去世|社会性死亡|原地爆炸|累死算了|困死算了|卷死了|考试去世)/;

export const CRISIS_GUARD_CONFIG: CrisisGuardConfig = {
  version: CRISIS_GUARD_CONFIG_VERSION,

  explicit_patterns: [
    DEATH_TERMS_ZH,
    DEATH_TERMS_EN,
    // 自杀/安乐死：意图词门控 + 疑问框架排除（R1 fix 1）。「项羽为什么要
    // 自杀」的「要自杀」被 (?<!为什么) 挡下；「我想自杀」「真想自杀」命中。
    // 裸「自杀」「自杀式袭击」「有人自杀吗」无意图词，不命中。
    /(?<!为什么)(?<!为何)(?<!为啥)(?<!怎么会)(想|要|打算|准备|敢|去).{0,4}(自杀|安乐死)/,
    // 过量/自杀手段的英文等价门控（R1 fix 1 同源修正）：意图短语而非裸
    // suicide；suicidal 自身即自述状态，保留裸词。
    /((going to|gonna|want to|plan(ning)? to|tried to|attempt(ing)? to|about to) commit suicide|suicide method|how to suicide)/,
    // 手段询问（C6「吃多少片安眠药会死」）：剂量/数量 × 药物 × 致死。
    /吃多少.{0,10}(片|颗|粒).{0,10}(死|致死|致命|没命)/,
    /(安眠药|褪黑素|药物).{0,12}(死|致死|致命|吃死|吞|过量)/,
    /(多少|几).{0,8}(片|颗|瓶).{0,12}(会|能|才).{0,6}(死|致死)/,
    /how many.{0,24}(pills|tablets|mg).{0,24}(die|kill|dead|lethal|overdose)/,
    // 中文自伤/自杀手段（R1 fix 2）：意图词门控；裸动词不触发——
    // 「物体从楼上跳下去做自由落体」必须 none，「我想跳楼」「好想从楼上
    // 跳下去」必须 explicit。
    /(想|好想|打算|准备|试着|尝试|敢).{0,6}(跳楼|跳下去|割腕|烧炭|上吊)/,
    /(我想|我要).{0,8}(跳楼|跳下去|割腕|烧炭|上吊)/,
    // 过量服药意图（R1 fix 2）：吃很多药/吞药带意图语境；完成式大量服药
    // （吞下一整瓶药）无论人称都按危机处理（宁过勿漏）。
    /(想|好想|打算|准备|试着|尝试).{0,6}(吃很多药|吃好多药|吃一大把药|吞药)/,
    /(吞|吃)下?(一大把|一整瓶|整瓶).{0,4}(药|片|安眠药|褪黑素)/,
    /(jump off|hang myself|hurt myself|self[- ]harm|cut myself)/,
    /(怎么死|如何自杀|自杀方法|怎么自杀|自杀方式|自杀工具)/,
    /how to (die|kill myself|commit suicide)/,
  ],

  indirect_patterns: [
    /(活着|人生|生命).{0,8}(没意思|没有意义|没意义|无所谓了|不值得)/,
    /(不想|不打算|没法|无法).{0,10}(撑|坚持|熬|挺).{0,10}(下去|到期末|到毕业|了)/,
    /(撑不到|熬不到|挺不过).{0,12}(期末|毕业|考试|明天|下周)/,
    /(消失|不见|解脱|离开).{0,8}(就好|算了|好了|的话)/,
    /(不想面对|无法面对).{0,12}(明天|以后|未来|一切)/,
    /(太累|好累|撑不住).{0,8}(想放弃一切|不想继续|想结束)/,
    /(feel like (giving up|disappearing)|no reason to (live|go on)|can't (take|do) this anymore|want (it to end|to disappear))/,
    /(i (feel|am) (empty|hopeless|worthless)|nothing matters anymore)/,
  ],

  quoted_ironic_patterns: [
    // 死亡梗词 + 同句玩笑信号（表情/笑声/梗字）→ 引用·反讽。
    new RegExp(
      `(${IRONIC_DEATH_TERMS.source.slice(2, -2)}|${DEATH_TERMS_ZH.source.slice(2, -2)}).{0,24}${JOKE_SIGNALS.source.slice(2, -2)}`,
    ),
    new RegExp(
      `${JOKE_SIGNALS.source.slice(2, -2)}.{0,24}(${IRONIC_DEATH_TERMS.source.slice(2, -2)}|${DEATH_TERMS_ZH.source.slice(2, -2)})`,
    ),
    // 「要做不出来我就…」条件玩笑形（C5）。
    /(做不出来|再错|考砸).{0,16}(就|我).{0,10}(去世|死了|没了|不行了)/,
    /if i (fail|screw up).{0,32}(die|dead|kill me|end me)/,
  ],

  distress_patterns: [
    /(每天|天天|连续).{0,6}(只)?睡.{0,4}(2|3|4|两三|三四|不到五?)(个)?小时/,
    /(压力|紧张|焦虑).{0,12}(大到|得|到).{0,12}(手抖|发抖|失眠|睡不着|喘不过气|崩溃|哭)/,
    /(撑不住|扛不住|熬不动).{0,12}(学不完|考试|月考|排名)/,
    /(can't sleep|insomnia|shaking|panic attack|burning out|breaking down).{0,24}(exam|test|school|study|homework)/,
  ],

  templates: {
    // 用于 explicit / indirect。
    full_support: {
      version: 'full-support-v1',
      review_status: '未审定',
      text_md: [
        '听到你这么说，我很在意你现在的状态。你现在愿意多说说吗？我在这里，可以陪你慢慢聊。',
        '',
        '如果你身边有让你觉得安全、信任的大人——家人、老师或者学校心理老师——希望你能把现在的情况告诉他们；让他们知道你在承受这些，不是小题大做。',
        '',
        '另外提供一些可以随时联系的支持渠道，仅供参考，不是诊断或命令：',
        '- 全国 24 小时心理援助热线：**12356**（中国大陆，工信部已将 12356 设为全国统一心理援助热线）',
        '- 北京心理危机研究与干预中心热线：010-82951332（24 小时）',
        '- 如果你不在大陆或更方便英文沟通：International Association for Suicide Prevention 站点列出了各国家/地区热线（findahelpline.com）',
        '',
        '学习的事先放一放完全没问题，想继续做题、看讲解也随时可以——这两件事不冲突。你现在的感受才是最重要的。',
      ].join('\n'),
    },
    // 用于 quoted_ironic：承认玩笑外壳，温和确认压力（原 gentle_checkin 拆分）。
    quoted_ironic: {
      version: 'quoted-ironic-v1',
      review_status: '未审定',
      text_md: [
        '这句话听起来像是玩笑，但也带了不少压力。最近是不是真的挺累的？',
        '',
        '如果只是玩梗，那就继续做题吧；如果确实有点撑不住，也可以直接跟我说说，或者找个信任的大人聊聊。学习和休息都可以调整，你不用一个人扛。',
        '',
        '想继续学的话我们随时继续。',
      ].join('\n'),
    },
    // 用于 distress：直面高压困扰，不暗示玩笑（R1 fix 3）。
    distress: {
      version: 'distress-v1',
      review_status: '未审定',
      text_md: [
        '听起来你最近承受的压力真的很重——睡不够、连着学不完，身体都开始发信号了。这种状态换成谁都会难受。',
        '',
        '愿意的话跟我说说现在最压着你的是哪一块？也可以考虑把现在的状态告诉一个你信任的大人——家人、老师或学校心理老师——让他们帮你一起扛，这不是示弱。',
        '',
        '如果这种紧绷已经影响到睡眠和身体好几周了，和学校心理老师或专业支持渠道聊一聊会有帮助；你自己决定什么时候、和谁聊。',
        '',
        '眼下的学习节奏可以先松一格：少刷一组题、先睡一觉，都不会让努力白费。想继续学的时候我们随时继续，想先歇口气也完全可以。',
      ].join('\n'),
    },
  },
};

/** 按类别取模板（显式与间接共用 full_support；引用·反讽、高压困扰各走各的）。 */
export function crisisTemplateForClass(
  detectionClass: Exclude<CrisisDetectionClass, 'none'>,
): CrisisTemplate {
  if (detectionClass === 'explicit' || detectionClass === 'indirect') {
    return CRISIS_GUARD_CONFIG.templates.full_support;
  }
  return CRISIS_GUARD_CONFIG.templates[detectionClass];
}
