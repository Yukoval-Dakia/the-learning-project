// Single versioned crisis-guard config: lexical detection plus response templates.
//
// Professional review status is UNREVIEWED: no qualified reviewer has been assigned,
// so no endorsement is claimed. A reviewed rewrite should change only this file and
// its version.
//
// Constraints: lexical only (no paid model classifier), no real institution contact,
// no diagnosis or lecturing, and the raw text never leaves the conversation store.

export const CRISIS_GUARD_CONFIG_VERSION = '4';

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
// Release decisions (why-questions, 死-compounds) are NOT in these patterns — they
// run as code in classify.ts#releaseRemainder. Patterns here only find terms.
//
// First-person-objectless rule for the endurance capture: the pronoun anchor must
// sit at a clause boundary (an optional discourse/vocative slot may precede it) so
// fronted task objects ("这题我撑不下去了" / "第三圈我就撑不住了") stay out, the
// gap between anchor and verb is adverb words or pronoun+的+psychosomatic nouns
// only ("我真的快" / "觉得我的心态快" hit; "再跑一圈就" / "他的腿" do not), and
// the verb complement must end the clause so a following object ("我熬不住夜" /
// "我扛不住这么重的书包") stays out.
const ENDURANCE_PRONOUNS =
  '我|俺|咱|自己|本人|老子|老娘|我们|咱们|你|您|他|她|它|牠|谁|偶|人家|朕|吾|吾辈|本宝宝|这边';
const ENDURANCE_POSSESSIVE_OK =
  '身体|身子|体力|精力|精神|心理|神经|内心|心态|情绪|意志|心|耐心|耐性|脑|家|日子|' +
  '生活|状态|人|生意|买卖|工作|事业|学业|感情|婚姻|关系|前途|未来|梦想|理想|希望|' +
  '真|太|很|非常|实在|确|的确|好|特别|格外|分外';
const CLAUSE_BOUNDARY_ZH = '，。！？；、：…—·.,!?;:\\s"\'“”‘’「」《》()（）';
const ENDURANCE_PREFIX_ZH =
  '(?:最近|这几天|这段时间|现在|其实|真的|实在|感觉|觉得|好像|突然|忽然|已经|' +
  '一直|总是|老是|快要|也|还|又|都|很|太|可能|也许|大概|有点|有些|确实|的确|早|' +
  '终于|反正|说实话|说真的|讲真的|老实说|不知道为什么|不知为何|总之|今晚|今天|' +
  '昨天|明天|每天这样|每天|天天|老师|救命|救救我|帮帮我|帮帮忙|各位)?';
// A bare 的 counts as a tail only at an utterance/clause end — "我扛不住的箱子"
// is an attributive object, not an endurance collapse.
const ENDURANCE_TAIL = `(?=$|[${CLAUSE_BOUNDARY_ZH}]|了|吗|呢|吧|啊|呀|哈|哦|唉|哎|呜|啦|咯|嘛|么|的(?=$|[${CLAUSE_BOUNDARY_ZH}]))`;
const ENDURANCE_VERB_ZH = '(?:撑|熬|挺|坚持|扛|顶)不(?:下去|住|动|了了)';
const PERSON_ANCHOR_ZH =
  '(?:我|俺|咱|自己|本人|老子|老娘|我们|咱们|偶|人家|朕|吾|吾辈|本宝宝|这边)';
const ENDURANCE_ADV_ZH =
  '(?:真的|实在|快|快要|已经|就|也|还|又|都|很|太|好|有点|有些|感觉|觉得|好像|' +
  '突然|忽然|一直|总是|老是|马上|立刻|终于|早|可能|大概|也许|确实|的确|非常|特别|再也|还是)';
const ENDURANCE_GAP_ZH = `(?:(?:${ENDURANCE_ADV_ZH})|(?:(?:${ENDURANCE_PRONOUNS})的(?:${ENDURANCE_POSSESSIVE_OK}))){0,5}`;
// 结束这一切 tail excludes 的 so an object ("结束这一切的争论") stays out.
const END_ALL_TAIL = `(?=$|[${CLAUSE_BOUNDARY_ZH}]|了|吗|呢|吧|啊|呀|哈|哦|唉|哎|呜|啦|咯|嘛|么)`;
// Volition/person markers that license "死了算" / "结束这一切" away from a clause
// boundary; adjective-intensity forms ("累死了算了" / "难死了算了") carry none.
const VOLITION_ZH =
  '不如|干脆|还不如|索性|真想|想|想要|要|打算|准备|希望|恨不得|我|俺|咱|自己|本人|老子|老娘|我们|咱们|偶|人家|朕|吾|吾辈|本宝宝|这边|只能|只好|就|还是|真|实在';

const DEATH_TERMS_ZH =
  /(不想活|活不下去|想死|想去死|要去死|去死吧|轻生|结束自己|结束生命|了结自己|了结生命|解脱了|一了百了)/;
// Colloquial intensifiers ("gonna die of boredom", "end it with a quote") are only
// counted as crisis when anchored to first person and not followed by an object or
// cause — "i wanna die" hits, "i wanna die of boredom" does not.
const EN_DIE_TAIL = '(?! *(?:of|from|because|laughing|bored|in this|when))';
const EN_END_IT_TAIL = '(?! *(?:with|a|the|by|in|on|at|before|when|using|through|to))';
// English terms carry full word boundaries so substrings inside ordinary words
// stay out ("want to diet", "skill myself", "defend my life", "spend it all").
const DEATH_TERMS_EN = new RegExp(
  '(\\b(?:kill myself|killing myself|end my life|ending my life|' +
    'want to die|wanted to die|suicidal|better off dead|' +
    "not want to live|don't want to live|dont want to live|do not want to live|" +
    "not want to be alive|don't want to be alive|dont want to be alive|" +
    'do not want to be alive|end it all)\\b|' +
    `i\\b.{0,24}?\\b(?:wanna|gonna|going to) (?:die\\b${EN_DIE_TAIL}|end it\\b${EN_END_IT_TAIL}|kill myself)|` +
    `i\\b.{0,24}?\\bwant(?:ed)? to end it\\b${EN_END_IT_TAIL})`,
);
const JOKE_SIGNALS = /(😂|🤣|哈哈哈|hhhh|233|笑死|梗|烂梗)/;
const IRONIC_DEATH_TERMS =
  /(原地去世|当场去世|去世了|我先去世|社会性死亡|原地爆炸|累死算了|困死算了|卷死了|考试去世)/;

export const CRISIS_GUARD_CONFIG: CrisisGuardConfig = {
  version: CRISIS_GUARD_CONFIG_VERSION,

  explicit_patterns: [
    DEATH_TERMS_ZH,
    DEATH_TERMS_EN,
    // Intent-gated methods; third-party why-questions are released by code, not here.
    /(?:想|要|打算|准备|敢|去).{0,4}(?:自杀|安乐死)/,
    // English equivalent: intent phrases, not bare suicide; suicidal is self-description.
    /\b((going to|gonna|want to|plan(ning)? to|tried to|attempt(ing)? to|about to) commit suicides?|suicide methods?|how to suicide)\b/,
    // Method inquiry: dose/count × drug × lethal outcome.
    /吃多少.{0,10}(片|颗|粒).{0,10}(死|致死|致命|没命)/,
    /(安眠药|褪黑素|药物).{0,12}(死|致死|致命|吃死|吞|过量)/,
    /(多少|几).{0,8}(片|颗|瓶).{0,12}(会|能|才).{0,6}(死|致死)/,
    /how many.{0,24}\b(pills|tablets|mgs?)\b.{0,24}\b(die|kills?|dead|lethal|overdose)\b/,
    // Intent-gated methods: "物体从楼上跳下去做自由落体" stays none; "我想跳楼" is explicit.
    /(想|好想|打算|准备|试着|尝试|敢).{0,6}(跳楼|跳下去|割腕|烧炭|上吊)/,
    /(我想|我要).{0,8}(跳楼|跳下去|割腕|烧炭|上吊)/,
    // Intent-gated; a completed large ingestion counts as crisis regardless of person.
    /(想|好想|打算|准备|试着|尝试).{0,6}(吃很多药|吃好多药|吃一大把药|吞药)/,
    /(吞|吃)下?(一大把|一整瓶|整瓶).{0,4}(药|片|安眠药|褪黑素)/,
    /\b(jump off|hang myself|hurt myself|self[- ]harm|cut myself)\b/,
    // No factive frame gate: method-shopping phrasing always hits, so academic
    // "海明威是怎么死的" is a documented known false positive, not a released miss.
    /(?:怎么死|怎么自杀|如何自杀|自杀方法|自杀方式|自杀工具)/,
    /how to (die|kill myself|commit suicide)\b/,
  ],

  indirect_patterns: [
    /(?:活着|人生|生命).{0,8}(?:没意思|没有意义|没意义|无所谓了|不值得)/,
    /(?:不想|不打算|没法|无法).{0,10}(?:撑|坚持|熬|挺).{0,10}(?:下去|到期末|到毕业|了)/,
    /(?:撑不到|熬不到|挺不过).{0,12}(?:期末|毕业|考试|明天|下周)/,
    /(?:消失|不见|解脱|离开).{0,8}(?:就好|算了|好了|的话)/,
    /(?:不想面对|无法面对).{0,12}(?:明天|以后|未来|一切)/,
    /(?:太累|好累|撑不住).{0,8}(?:想放弃一切|不想继续|想结束)/,
    // Complement-negation forms ("我撑不下去了"), first-person objectless only: the
    // pronoun must open a clause, the gap is adverbs/psychosomatic possessives only,
    // and the complement must end the clause — see above.
    new RegExp(
      `(?:^|[${CLAUSE_BOUNDARY_ZH}])${ENDURANCE_PREFIX_ZH}${PERSON_ANCHOR_ZH}` +
        `(?:的(?:${ENDURANCE_POSSESSIVE_OK}))?${ENDURANCE_GAP_ZH}${ENDURANCE_VERB_ZH}${ENDURANCE_TAIL}`,
    ),
    // Subject-dropped form at a clause boundary ("撑不下去了", "先移项……撑不下去
    // 了"); a noun directly before the verb ("这座桥撑不下去了") or after the
    // complement ("撑不下去这道题了") keeps it out.
    new RegExp(`(?:^|[${CLAUSE_BOUNDARY_ZH}])${ENDURANCE_VERB_ZH}${ENDURANCE_TAIL}`),
    // The hardship word must close the clause — "难道" is a rhetorical opener
    // ("做人难道不应该诚实吗"), not an endurance collapse ("活着太难了").
    new RegExp(`(?:活着|做人).{0,6}(?:累|难|没劲)${END_ALL_TAIL}`),
    // "想不开" must close the clause too — an object after it is the literal
    // verb ("我想不开这个窗口"), not the endurance idiom.
    new RegExp(
      `(?:^|[${CLAUSE_BOUNDARY_ZH}])${ENDURANCE_PREFIX_ZH}` +
        `${PERSON_ANCHOR_ZH}.{0,6}想不开${END_ALL_TAIL}|(?:^|[${CLAUSE_BOUNDARY_ZH}])想不开${END_ALL_TAIL}`,
    ),
    // Resignation/burdensomeness forms with volition/boundary anchors: "累死了算了"
    // and "来结束这一切" stay out, and "需要我" must end the clause or take an
    // abstract-self object ("没有人需要我的帮助" stays none, "…我的存在" hits).
    new RegExp(
      `(?:${VOLITION_ZH}).{0,4}死了算了|(?:不如|还不如|干脆|索性)死了|(?:^|[${CLAUSE_BOUNDARY_ZH}])死了算了`,
    ),
    /想消失/,
    // The better-off word must close the clause — comparative objects stay out
    // ("有没有我更好理解的解法"), existential "没有我会更好" hits.
    new RegExp(`没(?:有|了)我.{0,6}(?:会更好|更好|清净|安宁)${END_ALL_TAIL}`),
    new RegExp(
      `(?:没有人|没人|谁也没|谁也不).{0,4}需要我` +
        `(?=$|[${CLAUSE_BOUNDARY_ZH}]|了|呢|吧|啊|呀|哈|哦|唉|哎|呜|啦|咯|嘛|么|` +
        '的存在|的存在感|的价值|的意义|的陪伴|的爱|的关心|的在乎)',
    ),
    new RegExp(
      `(?:${VOLITION_ZH}).{0,6}结束这一切${END_ALL_TAIL}|` +
        `(?:^|[${CLAUSE_BOUNDARY_ZH}])结束这一切${END_ALL_TAIL}`,
    ),
    // English first-person endurance collapse: the phrase must close the utterance
    // ("i can't go on, my leg hurts" and "…anymore, i'm out of breath" stay out);
    // "hold on" shares that ending restriction and also excludes "hold on to";
    // "bear it"/"stand it" are not terms.
    /i can'?t hold on(?! *to)(?: anymore| any longer| like this| living| like that)*(?=\s*(?:$|[.!?;]))/,
    /i can'?t (?:go on|keep going)(?: anymore| any longer| like this| living| like that)*(?=\s*(?:$|[.!?;]))/,
    /giv(?:e|ing) up on (?:life|everything|myself|the world)\b/,
    /feel like (?:giving up|disappearing)|no reason to (?:live|go on)\b|can'?t (?:take|do) (?:this|it) anymore\b|want (?:it to end|to disappear)\b/,
    /i (?:feel|am) (?:empty|hopeless|worthless)\b|nothing matters anymore\b/,
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
      version: 'full-support-v2',
      review_status: '未审定',
      text_md: [
        '听到你这么说，我很在意你现在的状态。你现在愿意多说说吗？我在这里，可以陪你慢慢聊。',
        '',
        '如果你身边有让你觉得安全、信任的大人——家人、老师或者学校心理老师——希望你能把现在的情况告诉他们；让他们知道你在承受这些，不是小题大做。',
        '',
        '另外提供一些可以随时联系的支持渠道，仅供参考，不是诊断或命令：',
        '- 全国统一心理援助热线：**12356**（中国大陆，由国家卫生健康委设置）',
        '- 北京市心理援助热线（北京心理危机研究与干预中心）：手机拨 010-82951332，座机拨 800-810-1117（每天 24 小时）',
        '- 如果你不在大陆或更方便英文沟通：findahelpline.com 收录了 175 个以上国家/地区的心理援助热线，可以按所在地区查询',
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
      version: 'distress-v2',
      review_status: '未审定',
      text_md: [
        '听起来你最近承受的压力真的很重，重到已经在影响你的状态了。这种感受换成谁都不好受。',
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
