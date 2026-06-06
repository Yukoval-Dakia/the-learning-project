import type { SubjectProfile } from '../profile';

export const wenyanProfile: SubjectProfile = {
  id: 'wenyan',
  version: '1.0.0',
  displayName: '文言文',
  languageStyle: '中文讲解，保留必要的古文术语，重视原文证据和语法功能。',
  questionKinds: [
    'single_choice',
    'multiple_choice',
    'short_answer',
    'translation',
    'reading_comprehension',
  ],
  judgePolicy: {
    preferredRoutes: ['exact', 'keyword', 'semantic', 'ai_flexible'],
    notes: [
      '客观题优先 exact。',
      '术语或要点题优先 keyword。',
      '翻译、赏析、开放解释题后续接入 semantic / ai_flexible。',
    ],
  },
  exampleSources: ['古文原文', '课内注释', '用户错题', '教师整理材料'],
  noteTemplate: {
    definition: '术语或知识点定义，必要时给出古今义差异。',
    mechanism: '解释语法功能、句式机制或阅读判断步骤。',
    example: '引用短句并标明关键字词。',
    pitfall: '列出常见误译、词性误判或题面误读。',
    check: '给出一个小题检验是否真正掌握。',
  },
  grounding: {
    requirement: '结论必须能回到题面、原文、注释或用户材料。',
    allowedSources: ['user_material', 'textbook', 'teacher_note', 'llm_prior'],
    uncertaintyPolicy: '材料不足时标注不确定，不编造出处。',
  },
  promptFragments: {
    roleNoun: '文言文学习教练',
    noteExamplePolicy: '优先使用原文短句和课内常见例句，避免脱离材料泛讲。',
    variantExamplePolicy: '变式题保持同一语法点或阅读技能，不机械替换字词。',
    teachingStyle: '先定位文本证据，再解释判断过程，最后给出可复用规则。',
    checkQuestionPolicy: '检查题应短小，聚焦一个词义、句式或翻译判断。',
    learningIntentPolicy: '把模糊目标改写成可练习的古文阅读或翻译能力。',
  },
  causeCategories: [
    {
      id: 'concept',
      label: '概念理解',
      description: '对术语定义、文本理解框架或概念边界的抽象理解错误',
      review_priority: 5,
    },
    {
      id: 'knowledge_gap',
      label: '知识缺失',
      description: '缺少必要的古文知识背景',
      review_priority: 4,
    },
    { id: 'reading', label: '审题偏差', description: '题面信息遗漏或误读', review_priority: 3 },
    {
      id: 'memory',
      label: '记忆混淆',
      description: '已学内容的记忆不牢固或混淆',
      review_priority: 3,
    },
    {
      id: 'expression',
      label: '表达不当',
      description: '理解正确但表述不清或不完整',
      review_priority: 3,
    },
    {
      id: 'grammar',
      label: '语法判断',
      description: '词类活用、虚词功能、句式判断错误',
      review_priority: 4,
      variant_targetable: true,
    },
    {
      id: 'word_meaning',
      label: '词义混淆',
      description: '古今异义、一词多义或固定搭配辨析错误',
      review_priority: 4,
      variant_targetable: true,
    },
    {
      id: 'method',
      label: '方法选择',
      description: '翻译策略、审题方向或阅读分析方法选择不当',
      review_priority: 3,
      variant_targetable: true,
    },
    {
      id: 'time_pressure',
      label: '时间压力',
      description: '限时阅读或翻译节奏失稳，步骤选择稳定性下降',
      review_priority: 2,
      variant_targetable: true,
    },
    {
      id: 'carelessness',
      label: '粗心',
      description: '非知识性的笔误或遗漏',
      review_priority: 2,
      variant_targetable: false,
    },
    { id: 'other', label: '其它', review_priority: 2, variant_targetable: false },
  ],
  renderConfig: {
    font_family: 'serif-cjk',
    notation: null,
    code_highlight: null,
  },
  schedulingHints: {
    default_policy: 'fsrs',
  },
  judgeCapabilities: ['exact', 'keyword', 'semantic'],
  // YUK-225 (S2 slice 4) — OF-1 首批源白名单候选 (调研报告
  // .omc/research/2026-06-05-source-whitelist-candidates.md, owner review pending).
  // 各域名形态 / owner 待确认项:
  //   gzywtk.com      — 一苇轩高中语文题库, 文言文专项, 无登录 / HTML 内联 / 单题+解析
  //                     (形态: 题库站, 最适合检索); owner 待确认 UGC 版权边界。
  //   gaokao.eol.cn   — 中国教育在线·掌上高考, 历年高考真题(含文言文), 官方媒体 / 无登录
  //                     (形态: 真题多以图片嵌入, OCR 抽取有难度); owner 待确认转载授权。
  //   gaokao.zxxk.com — 学科网高考专项子站 (形态: 登录边界待人工确认, 比主站墙低);
  //                     条件推荐, owner 手动验证无墙范围后再倚重。
  //   gaokao.neea.edu.cn — 教育部中国教育考试网, 权威性最高 (形态: 内容是试题评析文章
  //                     非逐题题库, SSL 证书不稳); owner 待确认是否作低优先权威参考。
  sourceWhitelist: ['gzywtk.com', 'gaokao.eol.cn', 'gaokao.zxxk.com', 'gaokao.neea.edu.cn'],
  // 阅读题直奔素材线 (真原文锚); 翻译题优先找现成题源, 不足再据材生成。
  sourcingRoutePreference: {
    reading_comprehension: ['material', 'sourced', 'closed_book'],
    translation: ['sourced', 'material', 'closed_book'],
  },
};
