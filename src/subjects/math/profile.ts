import type { SubjectProfile } from '../profile';

export const mathProfile: SubjectProfile = {
  id: 'math',
  version: '1.0.0',
  displayName: '数学',
  languageStyle: '中文讲解，强调定义、条件、推导步骤和符号一致性。',
  questionKinds: [
    'single_choice',
    'multiple_choice',
    'short_answer',
    'calculation',
    'proof',
    'word_problem',
  ],
  judgePolicy: {
    preferredRoutes: ['exact', 'keyword', 'steps', 'semantic', 'ai_flexible'],
    notes: [
      '最终答案可用 exact / keyword 初筛。',
      '推导题和证明题后续接入 steps / rubric。',
      '含公式渲染的题目由 renderConfig.notation 指定 katex。',
    ],
  },
  exampleSources: ['题面条件', '教材定义', '公式定理', '用户解题步骤'],
  noteTemplate: {
    definition: '写清定义、适用条件和符号含义。',
    mechanism: '拆解公式来源、变形依据和解题策略。',
    example: '给出带步骤的短例题，保留关键中间式。',
    pitfall: '列出易漏条件、计算错误和方法误选。',
    check: '给出一个同类小题或一步推导检查。',
  },
  grounding: {
    requirement: '推导必须能追溯到题面条件、定义、定理或用户已有步骤。',
    allowedSources: ['user_material', 'textbook', 'formula_sheet', 'llm_prior'],
    uncertaintyPolicy: '条件不足时指出缺少的条件，不默认补题。',
  },
  promptFragments: {
    roleNoun: '数学学习教练',
    noteExamplePolicy: '例题必须标出条件、目标和每一步变形依据。',
    variantExamplePolicy: '变式题保持同一核心方法，同时改变数值或条件组合。',
    teachingStyle: '先检查条件和目标，再给推导路径，最后总结方法触发信号。',
    checkQuestionPolicy: '检查题应聚焦一个公式、条件判断或关键变形。',
    learningIntentPolicy: '把模糊目标改写成可练习的题型、知识点或解题步骤。',
  },
  causeCategories: [
    {
      id: 'concept',
      label: '概念理解',
      description: '对数学定义、定理、条件的理解错误',
      review_priority: 5,
    },
    {
      id: 'knowledge_gap',
      label: '知识缺失',
      description: '缺少解题所需的数学知识',
      review_priority: 4,
    },
    {
      id: 'calculation',
      label: '运算错误',
      description: '代数计算、数值运算失误',
      review_priority: 3,
    },
    {
      id: 'method',
      label: '方法选择',
      description: '解题方法或策略选择不当',
      review_priority: 4,
    },
    { id: 'reading', label: '审题偏差', description: '题面条件遗漏或误读', review_priority: 3 },
    {
      id: 'memory',
      label: '记忆混淆',
      description: '公式、定理的记忆不准确',
      review_priority: 3,
    },
    {
      id: 'expression',
      label: '表达不规范',
      description: '推导步骤省略或书写不清',
      review_priority: 3,
    },
    { id: 'unit_error', label: '单位错误', description: '量纲或单位换算错误', review_priority: 2 },
    {
      id: 'carelessness',
      label: '粗心',
      description: '非知识性的计算笔误或抄写错误',
      review_priority: 2,
    },
    { id: 'other', label: '其它', review_priority: 2 },
  ],
  renderConfig: {
    font_family: 'system',
    notation: 'katex',
    code_highlight: null,
  },
  schedulingHints: {
    default_policy: 'fsrs',
  },
  // M2.1 (2026-05-22): + 'steps' for derivation question kind.
  // steps@1 capability is registered in default registry; run() body lands in M2.2.
  judgeCapabilities: ['exact', 'keyword', 'steps'],
};
