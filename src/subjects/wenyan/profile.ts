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
      description: '对文言词义、语法功能的核心概念理解错误',
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
      id: 'carelessness',
      label: '粗心',
      description: '非知识性的笔误或遗漏',
      review_priority: 2,
    },
    { id: 'other', label: '其它', review_priority: 2 },
  ],
  renderConfig: {
    font_family: 'serif-cjk',
    notation: null,
    code_highlight: null,
  },
  schedulingHints: {
    default_policy: 'fsrs',
  },
  judgeCapabilities: ['exact', 'keyword'],
};
