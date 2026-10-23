// Plain names for the companion's tools, shared by the step rows and the saved-result cards. Every
// tool the companion can call has a name here; an unknown one falls back by what it does (look up,
// suggest, write), so no row ever reads as a generic "task".

export const TOOL_LABELS: Readonly<Record<string, string>> = {
  query_memory_brief: '学习概况',
  generate_goal_outline: '目标大纲',
  generate_question_candidate: '题目草稿',
  get_subject_graph_overview: '知识概览',
  query_knowledge: '知识点',
  query_events: '学习动态',
  query_records: '学习记录',
  get_record_context: '记录详情',
  get_question_context: '题目详情',
  query_mistakes: '错题分析',
  get_attempt_context: '作答详情',
  get_review_due: '待复习内容',
  get_learning_item_context: '学习项详情',
  expand_knowledge_subgraph: '关联知识',
  find_knowledge_paths: '知识路径',
  search_bank: '题库检索',
  read_bank: '题库内容',
  check_bank: '题库检查',
  search_memory_facts: '记忆检索',
  propose_knowledge_edge: '知识关联提议',
  propose_knowledge_mutation: '知识调整提议',
  propose_learning_item_completion: '完成学习提议',
  propose_learning_item_relearn: '重新学习提议',
  propose_learning_item_defer: '推迟学习提议',
  propose_learning_item_archive: '归档学习提议',
  author_question: '题目生成结果',
  propose_question_edit: '题目修改提议',
  attribute_mistake: '错因分析结果',
  propose_variant: '变式提议',
  write_quiz: '练习生成结果',
  author_artifact: '资料生成结果',
  update_artifact: '资料更新结果',
  // Tools the step rows meet that have no saved-result card.
  knowledge_mutation: '学习内容建议',
  edit_question: '题目修改',
  submit_review_answer: '提交作答',
  read_agent_notes: '查看学习笔记',
  write_agent_note: '记一条学习笔记',
  file_bank_gap: '登记题库缺口',
  present_primary_view: '整理要给你看的内容',
};

const FALLBACKS: ReadonlyArray<[RegExp, string]> = [
  [/^propose_/, '提出建议'],
  [/^(?:query|get|search|read|find|expand|check)_/, '查阅学习资料'],
  [/^(?:write|author|update|generate|edit)_/, '整理内容'],
];

export function toolLabel(toolName: string): string {
  const known = TOOL_LABELS[toolName];
  if (known) return known;
  for (const [pattern, label] of FALLBACKS) if (pattern.test(toolName)) return label;
  return '处理中的一步';
}
