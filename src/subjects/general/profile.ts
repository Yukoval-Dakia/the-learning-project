import { UNIVERSAL_RATING_POLICY } from '@/core/schema/profile-decl';
import type { SubjectProfile } from '../profile';

// Neutral fallback profile for untagged or unknown domains: system font, no
// notation, generic Chinese voice. The sample subjects (yuwen/math/physics) are
// examples, not the product's identity.
//
// `general` is deliberately not in BUILTIN_IDS: nodes are never tagged
// with it, so it is never a goal-scope candidate or a derived subject axis.
export const generalProfile: SubjectProfile = {
  id: 'general',
  version: '1.0.0',
  displayName: '通用',
  languageStyle: '中文讲解，表述清晰，重视证据和可追溯，不绑定特定学科术语。',
  questionKinds: ['single_choice', 'multiple_choice', 'short_answer'],
  judgePolicy: {
    preferredRoutes: ['exact', 'keyword', 'semantic'],
    notes: ['客观题优先 exact。', '要点题优先 keyword。', '开放解释题走 semantic。'],
  },
  exampleSources: ['题面', '用户材料', '用户错题'],
  noteTemplate: {
    definition: '写清概念或知识点的定义与适用范围。',
    mechanism: '解释其原理、机制或判断步骤。',
    example: '给出一个贴合知识点的简短示例。',
    pitfall: '列出常见误区或易错点。',
    check: '给出一个小题检验是否真正掌握。',
  },
  grounding: {
    requirement: '结论必须能回到题面、用户材料或可核查依据。',
    allowedSources: ['user_material', 'llm_prior'],
    uncertaintyPolicy: '材料不足时标注不确定，不编造出处。',
  },
  promptFragments: {
    roleNoun: '学习教练',
    noteExamplePolicy: '示例贴合知识点，避免脱离材料泛讲。',
    variantExamplePolicy: '变式题保持同一知识点或能力目标，不机械替换字词。',
    teachingStyle: '先给出依据，再解释判断过程，最后给出可复用规则。',
    checkQuestionPolicy: '检查题应短小，聚焦一个概念或判断点。',
    learningIntentPolicy: '把模糊目标改写成可练习的具体能力。',
    methodology: '',
    rubricGuidance: '',
  },
  causeCategories: [
    {
      id: 'concept',
      label: '概念理解',
      description: '对定义、框架或概念边界的理解错误',
      review_priority: 5,
      // Cause semantics are profile-owned.
      meta_cause_prior: 'flawed_model',
      rating_lean: 'conceptual',
      variant_strategy: '同概念不同语境 / 反向考查（验证概念边界）',
    },
    {
      id: 'knowledge_gap',
      label: '知识缺失',
      description: '缺少必要的背景知识',
      review_priority: 4,
      meta_cause_prior: 'knowledge_gap',
      variant_strategy: '补充该知识点的典型变体',
    },
    {
      id: 'reading',
      label: '审题偏差',
      description: '题面信息遗漏或误读',
      review_priority: 3,
      meta_cause_prior: 'representation_failure',
      variant_strategy: '改提问方式 + 加干扰信息',
    },
    {
      id: 'memory',
      label: '记忆混淆',
      description: '已学内容的记忆不牢固或混淆',
      review_priority: 3,
      meta_cause_prior: 'retrieval_failure',
      variant_strategy: '不同表述测同一记忆点',
    },
    {
      id: 'expression',
      label: '表达不当',
      description: '理解正确但表述不清或不完整',
      review_priority: 3,
      meta_cause_prior: 'representation_failure',
      variant_strategy: '同题重写答案要求（重点检查表达）',
    },
    {
      id: 'method',
      label: '方法选择',
      description: '解题方向或分析方法选择不当',
      review_priority: 3,
      variant_targetable: true,
      meta_cause_prior: 'rule_misapplication',
      variant_strategy: '提示备选方法 + 同类型题',
    },
    {
      id: 'carelessness',
      label: '粗心',
      description: '非知识性的笔误或遗漏',
      review_priority: 2,
      variant_targetable: false,
      meta_cause_prior: 'execution_slip',
      rating_lean: 'carelessness',
    },
    {
      id: 'other',
      label: '其它',
      review_priority: 2,
      variant_targetable: false,
      meta_cause_prior: null,
    },
  ],
  ratingPolicy: UNIVERSAL_RATING_POLICY,
  renderConfig: {
    font_family: 'system',
    notation: null,
    code_highlight: null,
  },
  schedulingHints: {
    default_policy: 'fsrs',
  },
  judgeCapabilities: ['exact', 'keyword', 'semantic'],
  // No curated sources: everything is whitelist_match=false. Omitting
  // sourcingRoutePreference keeps the default sourced→material→closed_book order.
  sourceWhitelist: [],
};
