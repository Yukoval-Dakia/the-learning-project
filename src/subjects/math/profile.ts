import { UNIVERSAL_RATING_POLICY } from '@/core/schema/profile-decl';
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
    // Empty string is the legal initial state (matches the schema default).
    methodology: '',
    rubricGuidance: '',
  },
  causeCategories: [
    {
      id: 'concept',
      label: '概念理解',
      description: '对数学定义、定理、条件的理解错误',
      review_priority: 5,
      // Cause semantics are profile-owned.
      meta_cause_prior: 'flawed_model',
      rating_lean: 'conceptual',
      variant_strategy: '同概念不同语境 / 反向考查（验证概念边界）',
    },
    {
      id: 'knowledge_gap',
      label: '知识缺失',
      description: '缺少解题所需的数学知识',
      review_priority: 4,
      meta_cause_prior: 'knowledge_gap',
      variant_strategy: '补充该知识点的典型变体',
    },
    {
      id: 'calculation',
      label: '运算错误',
      description: '代数计算、数值运算失误',
      review_priority: 3,
      meta_cause_prior: 'execution_slip',
      variant_strategy: '改数据 + 留同样陷阱（验证计算稳定性）',
    },
    {
      id: 'method',
      label: '方法选择',
      description: '解题方法或策略选择不当',
      review_priority: 4,
      meta_cause_prior: 'rule_misapplication',
      variant_strategy: '提示备选方法 + 同类型题',
    },
    {
      id: 'reading',
      label: '审题偏差',
      description: '题面条件遗漏或误读',
      review_priority: 3,
      meta_cause_prior: 'representation_failure',
      variant_strategy: '改提问方式 + 加干扰信息',
    },
    {
      id: 'memory',
      label: '记忆混淆',
      description: '公式、定理的记忆不准确',
      review_priority: 3,
      meta_cause_prior: 'retrieval_failure',
      variant_strategy: '不同表述测同一记忆点',
    },
    {
      id: 'expression',
      label: '表达不规范',
      description: '推导步骤省略或书写不清',
      review_priority: 3,
      meta_cause_prior: 'representation_failure',
      variant_strategy: '同题重写答案要求（重点检查表达）',
    },
    {
      id: 'unit_error',
      label: '单位错误',
      description: '量纲或单位换算错误',
      review_priority: 2,
      meta_cause_prior: 'execution_slip',
      variant_strategy: '改变单位、量纲或换算条件，检查单位一致性',
    },
    {
      id: 'carelessness',
      label: '粗心',
      description: '非知识性的计算笔误或抄写错误',
      review_priority: 2,
      variant_targetable: false,
      meta_cause_prior: 'execution_slip',
      rating_lean: 'carelessness',
    },
    {
      id: 'time_pressure',
      label: '时间压力',
      description: '限时条件下步骤选择、节奏或计算稳定性下降',
      review_priority: 2,
      variant_targetable: true,
      meta_cause_prior: 'execution_slip',
    },
    {
      id: 'other',
      label: '其它',
      review_priority: 2,
      variant_targetable: false,
      meta_cause_prior: null,
    },
  ],
  // FSRS is subject-agnostic today, so math declares the universal map.
  ratingPolicy: UNIVERSAL_RATING_POLICY,
  renderConfig: {
    font_family: 'system',
    notation: 'katex',
    code_highlight: null,
  },
  schedulingHints: {
    default_policy: 'fsrs',
  },
  // steps owns derivations, so multimodal_direct is available only as an explicit
  // override here and is deliberately absent from preferredRoutes.
  judgeCapabilities: ['exact', 'keyword', 'semantic', 'steps', 'multimodal_direct'],
  // First-batch source whitelist candidates; owner confirmation still pending.
  //   gaokao.eol.cn      — official media, 2010–2025 papers, OCR needed.
  //   gaokao.zxxk.com    — login boundary unconfirmed.
  //   gaokao.neea.edu.cn — highest authority, articles rather than a paper bank.
  //   www.jyeoo.com      — jyeoo_fetch producer host; listed so its items sort normally.
  sourceWhitelist: ['gaokao.eol.cn', 'gaokao.zxxk.com', 'gaokao.neea.edu.cn', 'www.jyeoo.com'],
  // Prefer real papers, then closed-book generation / variants.
  sourcingRoutePreference: {
    calculation: ['sourced', 'closed_book', 'variant'],
  },
};
