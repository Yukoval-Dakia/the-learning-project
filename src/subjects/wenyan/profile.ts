import type { SubjectProfile } from '../profile';

export const wenyanProfile: SubjectProfile = {
  id: 'wenyan',
  displayName: '文言文',
  languageStyle: '中文，短句，直接指出原文语法功能与现代汉语含义。',
  questionKinds: ['short_answer', 'multiple_choice', 'reading', 'translation'],
  judgePolicy: {
    preferredRoutes: ['llm_rubric', 'exact_keyword'],
    notes: [
      '短答优先看语义与关键词，不要求字面完全一致。',
      '引用原文时必须能对应到给定题面或已知经典篇目。',
    ],
  },
  exampleSources: ['经典文言篇目', '用户已录入题面', '已验证笔记 sections'],
  noteTemplate: {
    definition: '核心概念或用法定义。',
    mechanism: '语法功能、触发条件、用法分类。',
    example: '经典原文例句 + 简短解析。',
    pitfall: '易混义项、误译、断句或语境误判。',
    check: '短答式自检题。',
  },
  grounding: {
    requirement: '经典篇目例子优先；不确定来源时必须标注待核。',
    allowedSources: ['经典原文', '用户题面', '已审核知识点'],
    uncertaintyPolicy: '不确定的明说「不确定 / 待核」，不强行编造。',
  },
  promptFragments: {
    roleNoun: '文言文学习',
    noteExamplePolicy: '文言文示例首选经典原文（《师说》《伶官传序》之类），不自创',
    variantExamplePolicy: '文言文示例首选经典原文，不自创',
    teachingStyle: '用文言文经典原文示例（《师说》《伶官传序》之类），不自创',
    checkQuestionPolicy: '文言文短答题首选',
    learningIntentPolicy: '围绕文言文知识点拆分为可讲、可练、可复习的 atomic 项。',
  },
};
