// Single versioned crisis-guard config: lexical detection plus response templates.
//
// Professional review status is UNREVIEWED: no qualified reviewer has been assigned,
// so no endorsement is claimed. A reviewed rewrite should change only this file and
// its version.
//
// Constraints: lexical only (no paid model classifier), no real institution contact,
// no diagnosis or lecturing, and the raw text never leaves the conversation store.

export const CRISIS_GUARD_CONFIG_VERSION = '3';

/** 'none' means no match; normal flow, no crisis handling. */
export type CrisisDetectionClass = 'explicit' | 'indirect' | 'quoted_ironic' | 'distress' | 'none';

export interface CrisisTemplate {
  /** Bumped when the template is rewritten, so events can be reconciled. */
  readonly version: string;
  readonly review_status: '未审定' | '已审定';
  readonly text_md: string;
}

export interface CrisisGuardConfig {
  readonly version: string;
  /** Direct intent or method inquiry; bare words require intent/first-person context. */
  readonly explicit_patterns: readonly RegExp[];
  /** Hopelessness or giving up without an explicit death verb; treated as seriously. */
  readonly indirect_patterns: readonly RegExp[];
  /** Joke/meme usage; requires a death term AND a joke signal together. */
  readonly quoted_ironic_patterns: readonly RegExp[];
  /** Non-suicidal severe distress; never framed as a joke. */
  readonly distress_patterns: readonly RegExp[];
  readonly templates: {
    readonly full_support: CrisisTemplate;
    readonly quoted_ironic: CrisisTemplate;
    readonly distress: CrisisTemplate;
  };
}

// English matches lowercase (the classifier normalizes). Strong death terms are kept
// separate for reuse by the ironic rule; bare 自杀/安乐死 are excluded so historical,
// academic, or third-person mentions stay none.
//
// 死 + colloquial-verb compounds ("想死磕/想死扛/想死记/想死死缠" = grim determination,
// not a death wish) are excluded. Study verbs (读/写/算/刷) and pronouns stay unlisted
// — "我想死，题做不完" is ambiguous and a miss costs more than a false positive.
const SI_COMPOUND_CHARS =
  '磕|扛|撑|顶|缠|磨|黏|赖|跟|盯|抱|抓|捏|攥|揪|掐|拽|捂|记|背|啃|抠|命|宅|躺|睡|瘫|蹲|卷|死';

// Impersonal-why gate: "人为什么会想死" / "屈原为什么会想自杀" / "细胞为什么活不下去"
// are analysis questions, not disclosures. Blocks only when a why-word plus up to 4
// non-pronoun chars ends right at the term; a personal or pondering anchor within 6
// chars before the why-word ("我为什么想死", "不知道为什么就想死") rescues the hit,
// and a pronoun between the why-word and the term ("为什么我会想死") never blocks.
const WHY_WORD_ZH = '(?:为什么|为何|为啥|怎么会|咋|因何|何故|缘何|如何|怎么)';
const PRONOUN_CHAR_ZH = '[我你他她它牠谁俺咱们]';
const PERSON_ZH =
  '(?:我|俺|咱|你|您|自己|本人|老子|老娘|我们|咱们|你们|不知道|不知|想不通|搞不懂|弄不懂|不明白|不理解|好奇|纳闷)';
const WHY_GAP_ZH = `(?:(?!${PRONOUN_CHAR_ZH}).){0,4}`;
const WHY_GUARD_ZH = `(?:(?<!${WHY_WORD_ZH}${WHY_GAP_ZH})|(?<=${PERSON_ZH}.{0,6}${WHY_WORD_ZH}${WHY_GAP_ZH}))`;
// "why does hamlet want to die" is an essay question; "why do i want to die" keeps
// matching via the i/you/we rescue.
const WHY_GUARD_EN = '(?:(?<!why\\s+\\w+\\s+\\w+\\s+)|(?<=\\b(?:i|you|we)\\s+\\w{0,6}))';

// For the endurance pattern: a 的 directly after a pronoun is a possessive — it stays
// in the window only before psychosomatic/life-domain nouns or adverbial markers, so
// "我的身体快撑不住" and "我真的快熬不下去" hit while "我的纸桥快撑不下去" and
// "我觉得他的腿快撑不住了" do not. A 的 after any other char ("真的快") is free.
const ENDURANCE_PRONOUNS = '我|俺|咱|自己|本人|老子|老娘|我们|咱们|你|您|他|她|它|牠|谁';
const ENDURANCE_POSSESSIVE_OK =
  '身体|身子|体力|精力|精神|心理|神经|内心|心态|情绪|意志|心|耐心|耐性|脑|家|日子|' +
  '生活|状态|人|生意|买卖|工作|事业|学业|感情|婚姻|关系|前途|未来|梦想|理想|希望|' +
  '真|太|很|非常|实在|确|的确|好|特别|格外|分外';

const DEATH_TERMS_ZH = new RegExp(
  `(${WHY_GUARD_ZH}(?:不想活|活不下去|想死(?!${SI_COMPOUND_CHARS})|想去死(?!${SI_COMPOUND_CHARS})|要去死(?!${SI_COMPOUND_CHARS})|去死吧|轻生|结束自己|结束生命|了结自己|了结生命|解脱了|一了百了))`,
);
const DEATH_TERMS_EN = new RegExp(
  `(${WHY_GUARD_EN}(?:kill myself|killing myself|end my life|ending my life|` +
    'want to die|wanted to die|wanna die|gonna die|suicidal|better off dead|' +
    "not want to live|don't want to live|dont want to live|do not want to live|" +
    "not want to be alive|don't want to be alive|dont want to be alive|" +
    'do not want to be alive|end it all|want to end it|wanna end it|' +
    'going to end it|gonna end it))',
);
const JOKE_SIGNALS = /(😂|🤣|哈哈哈|hhhh|233|笑死|梗|烂梗)/;
const IRONIC_DEATH_TERMS =
  /(原地去世|当场去世|去世了|我先去世|社会性死亡|原地爆炸|累死算了|困死算了|卷死了|考试去世)/;

export const CRISIS_GUARD_CONFIG: CrisisGuardConfig = {
  version: CRISIS_GUARD_CONFIG_VERSION,

  explicit_patterns: [
    DEATH_TERMS_ZH,
    DEATH_TERMS_EN,
    // Intent-gated, with impersonal why-questions excluded: "我想自杀" matches,
    // "人为什么要自杀" does not, "我为什么想自杀" rescues via the pronoun anchor.
    new RegExp(`${WHY_GUARD_ZH}(?:想|要|打算|准备|敢|去).{0,4}(?:自杀|安乐死)`),
    // English equivalent: intent phrases, not bare suicide; suicidal is self-description.
    /((going to|gonna|want to|plan(ning)? to|tried to|attempt(ing)? to|about to) commit suicide|suicide method|how to suicide)/,
    // Method inquiry: dose/count × drug × lethal outcome.
    /吃多少.{0,10}(片|颗|粒).{0,10}(死|致死|致命|没命)/,
    /(安眠药|褪黑素|药物).{0,12}(死|致死|致命|吃死|吞|过量)/,
    /(多少|几).{0,8}(片|颗|瓶).{0,12}(会|能|才).{0,6}(死|致死)/,
    /how many.{0,24}(pills|tablets|mg).{0,24}(die|kill|dead|lethal|overdose)/,
    // Intent-gated methods: "物体从楼上跳下去做自由落体" stays none; "我想跳楼" is explicit.
    /(想|好想|打算|准备|试着|尝试|敢).{0,6}(跳楼|跳下去|割腕|烧炭|上吊)/,
    /(我想|我要).{0,8}(跳楼|跳下去|割腕|烧炭|上吊)/,
    // Intent-gated; a completed large ingestion counts as crisis regardless of person.
    /(想|好想|打算|准备|试着|尝试).{0,6}(吃很多药|吃好多药|吃一大把药|吞药)/,
    /(吞|吃)下?(一大把|一整瓶|整瓶).{0,4}(药|片|安眠药|褪黑素)/,
    /(jump off|hang myself|hurt myself|self[- ]harm|cut myself)/,
    // Factive/academic frame gate ("海明威是怎么死的" / "他怎么自杀的" → none);
    // bare method-shopping phrasing ("怎么死不痛苦" / "自杀方式有哪些") keeps matching.
    new RegExp(
      `(?<!(?:是|他|她|它|牠|谁).{0,4})(?:怎么死(?!${SI_COMPOUND_CHARS})|怎么自杀|如何自杀)` +
        '|(?:自杀方法|自杀方式|自杀工具)',
    ),
    /how to (die|kill myself|commit suicide)/,
  ],

  indirect_patterns: [
    // Person-anchored rows pass the same impersonal-why gate as explicit terms.
    new RegExp(`${WHY_GUARD_ZH}(?:活着|人生|生命).{0,8}(?:没意思|没有意义|没意义|无所谓了|不值得)`),
    new RegExp(
      `${WHY_GUARD_ZH}(?:不想|不打算|没法|无法).{0,10}(?:撑|坚持|熬|挺).{0,10}(?:下去|到期末|到毕业|了)`,
    ),
    new RegExp(`${WHY_GUARD_ZH}(?:撑不到|熬不到|挺不过).{0,12}(?:期末|毕业|考试|明天|下周)`),
    new RegExp(`${WHY_GUARD_ZH}(?:消失|不见|解脱|离开).{0,8}(?:就好|算了|好了|的话)`),
    new RegExp(`${WHY_GUARD_ZH}(?:不想面对|无法面对).{0,12}(?:明天|以后|未来|一切)`),
    new RegExp(`${WHY_GUARD_ZH}(?:太累|好累|撑不住).{0,8}(?:想放弃一切|不想继续|想结束)`),
    // Complement-negation forms the prefix-negation row cannot see ("我撑不下去了");
    // possessive filtering per ENDURANCE_POSSESSIVE_OK above.
    new RegExp(
      `(?:我|俺|咱|自己|本人|老子|老娘|我们|咱们)(?:(?!(?<=(?:${ENDURANCE_PRONOUNS}))的(?!(?:${ENDURANCE_POSSESSIVE_OK}))).){0,8}(?:撑|熬|挺|坚持|扛|顶)不(?:下去|住|动|了了)`,
    ),
    new RegExp(`${WHY_GUARD_ZH}(?:活着|做人).{0,6}(?:累|难|没劲)`),
    new RegExp(`${WHY_GUARD_ZH}想不开`),
    // English first-person endurance collapse; "hold on" keeps its object use free.
    /i can'?t (?:keep going|hold on(?! *to)|go on (?:like this|anymore)|bear it|stand it)/,
    new RegExp(
      `${WHY_GUARD_EN}(?:feel like (?:giving up|disappearing)|no reason to (?:live|go on)|can'?t (?:take|do) (?:this|it) anymore|want (?:it to end|to disappear))`,
    ),
    new RegExp(
      `${WHY_GUARD_EN}(?:i (?:feel|am) (?:empty|hopeless|worthless)|nothing matters anymore)`,
    ),
  ],

  quoted_ironic_patterns: [
    // Death term plus a same-sentence joke signal (emoji/laughter/meme) → quoted ironic.
    new RegExp(
      `(${IRONIC_DEATH_TERMS.source.slice(1, -1)}|${DEATH_TERMS_ZH.source.slice(1, -1)})` +
        `.{0,24}(${JOKE_SIGNALS.source.slice(1, -1)})`,
    ),
    new RegExp(
      `(${JOKE_SIGNALS.source.slice(1, -1)}).{0,24}` +
        `(${IRONIC_DEATH_TERMS.source.slice(1, -1)}|${DEATH_TERMS_ZH.source.slice(1, -1)})`,
    ),
    // Conditional joke form ("if I can't do this, I'll…").
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
    // Acknowledge the joke framing while gently checking in on the pressure.
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

/** Explicit and indirect share full_support; the other classes have their own template. */
export function crisisTemplateForClass(
  detectionClass: Exclude<CrisisDetectionClass, 'none'>,
): CrisisTemplate {
  if (detectionClass === 'explicit' || detectionClass === 'indirect') {
    return CRISIS_GUARD_CONFIG.templates.full_support;
  }
  return CRISIS_GUARD_CONFIG.templates[detectionClass];
}
