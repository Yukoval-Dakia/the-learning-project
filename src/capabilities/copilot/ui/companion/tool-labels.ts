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

// YUK-1664 — what the companion is doing right now, said to the learner while a step runs (the
// one-line activity before the reply text arrives). Common tools get their own phrase; any other
// tool reads as a verb by what it does plus its plain name, so no internal tool name ever shows.
const ACTIVITY: Readonly<Record<string, string>> = {
  query_memory_brief: '正在看你的学习概况',
  query_mistakes: '正在查你最近的错题',
  get_review_due: '正在看今天该复习什么',
  query_knowledge: '正在查相关的知识点',
  get_subject_graph_overview: '正在看知识的整体结构',
  expand_knowledge_subgraph: '正在找关联的知识点',
  find_knowledge_paths: '正在找知识点之间的联系',
  query_events: '正在看你最近的学习动态',
  query_records: '正在翻你的学习记录',
  get_record_context: '正在看这条记录',
  get_question_context: '正在看这道题',
  get_attempt_context: '正在看你这次的作答',
  get_learning_item_context: '正在看这个学习项',
  search_bank: '正在题库里找题',
  read_bank: '正在读题库里的题',
  check_bank: '正在核对题库',
  search_memory_facts: '正在回想你之前说过的情况',
  read_agent_notes: '正在看之前记下的学习笔记',
  write_agent_note: '正在记一条学习笔记',
  generate_question_candidate: '正在出题',
  author_question: '正在出题',
  write_quiz: '正在组一份练习',
  attribute_mistake: '正在分析错因',
  present_primary_view: '正在整理要给你看的内容',
};

const ACTIVITY_VERBS: ReadonlyArray<[RegExp, string]> = [
  [/^propose_/, '正在准备'],
  [/^(?:query|get|search|read|find|expand|check)_/, '正在查看'],
  [/^(?:write|author|update|generate|edit)_/, '正在整理'],
];

export function toolActivity(toolName: string): string {
  const known = ACTIVITY[toolName];
  if (known) return known;
  const label = toolLabel(toolName);
  for (const [pattern, verb] of ACTIVITY_VERBS)
    if (pattern.test(toolName)) return `${verb}${label}`;
  return label === '处理中的一步' ? '正在处理' : `正在处理：${label}`;
}
