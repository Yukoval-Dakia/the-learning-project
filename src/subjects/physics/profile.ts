import { UNIVERSAL_RATING_POLICY } from '@/core/schema/profile-decl';
import type { SubjectProfile } from '../profile';

// Physics profile. `derivation` is absent from questionKinds because it is not in
// SubjectQuestionKindSchema; adding it is a framework schema change.
export const physicsProfile: SubjectProfile = {
  id: 'physics',
  version: '1.0.0',
  displayName: '物理',
  languageStyle: '中文讲解，强调物理量定义、单位与量纲、推导链路。',
  questionKinds: ['single_choice', 'multiple_choice', 'short_answer', 'calculation'],
  judgePolicy: {
    // unit_dimension stays before multimodal_direct so calculations keep
    // precedence; multimodal_direct serves diagram-only calc questions with no
    // step rubric.
    preferredRoutes: ['exact', 'semantic', 'unit_dimension', 'multimodal_direct'],
    notes: [
      '数值题优先 unit_dimension（P1+ capability 落地后）。',
      '推导题复用 steps@1（与 math 共享 capability，不重写）。',
      '公式选择题走 exact / semantic。',
      '带图、无步骤评分表的计算/简答题走 multimodal_direct（整体视觉判分）。',
    ],
  },
  exampleSources: ['题面条件', '物理定律', '推导公式', '学生计算步骤'],
  noteTemplate: {
    definition: '写清物理量定义、单位、矢量/标量属性、适用条件。',
    mechanism: '拆解所用物理定律、推导链路、量纲一致性检查。',
    example: '给出带单位的完整推导例题，保留中间量纲。',
    pitfall: '列出易错单位换算、矢量方向、适用条件遗漏、量纲错位。',
    check: '给出一个量纲检查或单位换算小题。',
  },
  grounding: {
    requirement: '推导必须能追溯到物理定律、定义、量纲分析或题面条件。',
    allowedSources: ['user_material', 'textbook', 'formula_sheet', 'llm_prior'],
    uncertaintyPolicy: '条件不足时指出缺少的条件，不默认补题。',
  },
  promptFragments: {
    roleNoun: '物理学习教练',
    noteExamplePolicy: '例题必须带单位标注、每步推导依据、量纲一致性检查。',
    variantExamplePolicy: '变式题保持同一物理定律，改变数值、单位或场景设定。',
    teachingStyle: '先检查物理量与单位是否匹配，再给推导路径，最后做量纲检验。',
    checkQuestionPolicy: '检查题应聚焦一个公式应用、单位换算或量纲分析。',
    learningIntentPolicy: '把模糊目标改写成具体物理量推导、定律应用或单位换算练习。',
    methodology: '',
    rubricGuidance: '',
  },
  causeCategories: [
    {
      id: 'unit',
      label: '单位错误',
      description: '单位换算 / 单位丢失 / 单位错配',
      review_priority: 5,
      // Cause semantics are profile-owned.
      meta_cause_prior: 'representation_failure',
    },
    {
      id: 'dimension',
      label: '量纲错误',
      description: '量纲不平衡 / 物理意义错误',
      review_priority: 5,
      meta_cause_prior: 'representation_failure',
    },
    {
      id: 'formula',
      label: '公式错误',
      description: '公式记错 / 公式适用条件错',
      review_priority: 4,
      meta_cause_prior: 'retrieval_failure',
    },
    {
      id: 'concept',
      label: '概念理解',
      description: '对物理定义、定律、原理的理解错误',
      review_priority: 4,
      meta_cause_prior: 'flawed_model',
      rating_lean: 'conceptual',
      variant_strategy: '同概念不同语境 / 反向考查（验证概念边界）',
    },
    {
      id: 'computation',
      label: '计算错误',
      description: '数值代入 / 运算 / 进位错',
      review_priority: 2,
      meta_cause_prior: 'execution_slip',
    },
    {
      id: 'careless',
      label: '粗心',
      description: '看错条件、漏抄数据、符号写错',
      review_priority: 1,
      variant_targetable: false,
      meta_cause_prior: 'execution_slip',
      rating_lean: 'carelessness',
    },
    {
      id: 'other',
      label: '其他',
      description: '不在上述分类内的错',
      review_priority: 1,
      variant_targetable: false,
      meta_cause_prior: null,
    },
  ],
  // FSRS is subject-agnostic today, so physics declares the universal map.
  ratingPolicy: UNIVERSAL_RATING_POLICY,
  renderConfig: {
    font_family: 'system',
    notation: 'katex',
    code_highlight: null,
  },
  schedulingHints: {
    default_policy: 'fsrs',
  },
  // Every registry-backed preferredRoute must also be registered here.
  judgeCapabilities: ['exact', 'semantic', 'unit_dimension', 'multimodal_direct'],
  // First-batch source whitelist candidates; owner confirmation still pending.
  // Subject-specific sites are mostly paywalled, so only these general sources.
  sourceWhitelist: ['gaokao.eol.cn', 'gaokao.zxxk.com', 'gaokao.neea.edu.cn'],
  sourcingRoutePreference: {
    calculation: ['sourced', 'closed_book', 'variant'],
  },
};
