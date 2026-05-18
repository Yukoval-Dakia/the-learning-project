import type { SubjectProfile } from '../profile';

export const mathProfile: SubjectProfile = {
  id: 'math',
  displayName: '数学',
  languageStyle: '中文，步骤清楚，优先说明定义、条件、推导链和验算。',
  questionKinds: ['calculation', 'proof', 'concept_explain', 'word_problem'],
  judgePolicy: {
    preferredRoutes: ['symbolic_math', 'unit_dimension', 'llm_rubric', 'exact_keyword'],
    notes: [
      '计算题需要检查等价变形、代入验算和最终答案格式。',
      '应用题需要检查单位、量纲和题设条件是否被使用。',
    ],
  },
  exampleSources: ['用户已录入题面', '可验算的自造数值例', '已验证教材/笔记内容'],
  noteTemplate: {
    definition: '核心定义、适用条件和符号含义。',
    mechanism: '公式来源、推导步骤、变形条件。',
    example: '可验算例题，附关键步骤和答案检查。',
    pitfall: '漏条件、符号混淆、单位错误、非法变形。',
    check: '小计算或概念判断自检题。',
  },
  grounding: {
    requirement: '例题必须可独立验算；涉及单位时必须写出单位检查。',
    allowedSources: ['用户题面', '已验证笔记', '可验算推导'],
    uncertaintyPolicy: '无法验算的结论必须降级为待核，不写成确定事实。',
  },
  promptFragments: {
    roleNoun: '数学学习',
    noteExamplePolicy: '数学例子必须可验算，优先展示推导、关键步骤、单位或量纲检查',
    variantExamplePolicy: '数学变式要保留同一概念陷阱，改数据或条件后仍必须能完整解出',
    teachingStyle: '用步骤化讲解，必要时写出推导、代入验算、单位或量纲检查',
    checkQuestionPolicy: '短计算、概念判断或一步推导题',
    learningIntentPolicy: '围绕定义、方法、例题、误区和可检查练习拆分 atomic 项。',
  },
};
