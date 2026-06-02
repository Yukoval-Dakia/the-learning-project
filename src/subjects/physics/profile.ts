import type { SubjectProfile } from '../profile';

// P0 (2026-05-23): physics SubjectProfile per spec §5, normalized to actual
// framework schema:
//   - font_family / code_highlight use snake_case (spec draft used camelCase)
//   - schedulingHints needs default_policy (spec draft showed empty {})
//   - questionKinds excludes 'derivation' (not in SubjectQuestionKindSchema;
//     adding it = framework schema change, deferred to N+2)
// judgeCapabilities: ['exact', 'semantic', 'unit_dimension'] at P1. The
// unit_dimension runner is a skeleton until P2 implements real judging.
// See docs/superpowers/specs/2026-05-22-foundation-true-closeout-design.md §5

export const physicsProfile: SubjectProfile = {
  id: 'physics',
  version: '1.0.0',
  displayName: '物理',
  languageStyle: '中文讲解，强调物理量定义、单位与量纲、推导链路。',
  questionKinds: ['single_choice', 'multiple_choice', 'short_answer', 'calculation'],
  judgePolicy: {
    // YUK-201: multimodal_direct added AFTER unit_dimension so calc questions keep
    // unit_dimension precedence (the router checks the physics unit_dimension
    // branch BEFORE the gated multimodal_direct auto-route; see
    // question-contract.ts §2). multimodal_direct is the real consumer here:
    // physics calc WITH a diagram and NO step-rubric reference_solution.
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
  },
  causeCategories: [
    {
      id: 'unit',
      label: '单位错误',
      description: '单位换算 / 单位丢失 / 单位错配',
      review_priority: 5,
    },
    {
      id: 'dimension',
      label: '量纲错误',
      description: '量纲不平衡 / 物理意义错误',
      review_priority: 5,
    },
    {
      id: 'formula',
      label: '公式错误',
      description: '公式记错 / 公式适用条件错',
      review_priority: 4,
    },
    {
      id: 'concept',
      label: '概念理解',
      description: '对物理定义、定律、原理的理解错误',
      review_priority: 4,
    },
    {
      id: 'computation',
      label: '计算错误',
      description: '数值代入 / 运算 / 进位错',
      review_priority: 2,
    },
    {
      id: 'careless',
      label: '粗心',
      description: '看错条件、漏抄数据、符号写错',
      review_priority: 1,
      variant_targetable: false,
    },
    {
      id: 'other',
      label: '其他',
      description: '不在上述分类内的错',
      review_priority: 1,
      variant_targetable: false,
    },
  ],
  renderConfig: {
    font_family: 'system',
    notation: 'katex',
    code_highlight: null,
  },
  schedulingHints: {
    default_policy: 'fsrs',
  },
  // YUK-201: + 'multimodal_direct'. validateProfile requires every registry-backed
  // preferredRoute to also appear in judgeCapabilities (and be registered) — both
  // satisfied (registered in createDefaultRegistry).
  judgeCapabilities: ['exact', 'semantic', 'unit_dimension', 'multimodal_direct'],
};
