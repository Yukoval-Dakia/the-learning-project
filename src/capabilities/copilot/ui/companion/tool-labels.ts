// Plain names for the companion's tools, shared by the step rows and the saved-result cards. Every
// tool the companion can call has a name here; an unknown one falls back by what it does (look up,
// suggest, write), so no row ever reads as a generic "task".

export const TOOL_LABELS: Readonly<Record<string, string>> = {
  query_context: '学习概况',
  generate_goal_outline: '目标大纲',
  generate_question_candidate: '题目草稿',
  get_subject_graph_overview: '知识概览',
  query_knowledge: '知识点',
  query_events: '学习动态',
  query_records: '学习记录',
  get_record_context: '这条记录',
  get_question_context: '这道题',
  query_mistakes: '错题',
  get_attempt_context: '这次作答',
  get_review_due: '待复习内容',
  get_learning_item_context: '这项学习内容',
  expand_knowledge_subgraph: '关联知识',
  find_knowledge_paths: '知识点之间的联系',
  search_bank: '找题',
  read_bank: '看题库里的题',
  check_bank: '核对题目',
  propose_knowledge_edge: '建议关联知识点',
  propose_knowledge_mutation: '建议调整知识点',
  propose_learning_item_completion: '建议标记学完',
  propose_learning_item_relearn: '建议重新学',
  propose_learning_item_defer: '建议推迟',
  propose_learning_item_archive: '建议归档',
  author_question: '出的题',
  propose_question_edit: '建议改题',
  attribute_mistake: '错因',
  propose_variant: '建议换个变式',
  write_quiz: '组的练习',
  // Tools the step rows meet that have no saved-result card.
  knowledge_mutation: '建议调整学习内容',
  edit_question: '改题',
  submit_review_answer: '提交作答',
  reveal_answer: '给参考答案',
  read_agent_notes: '看之前记的笔记',
  write_agent_note: '记一笔',
  file_bank_gap: '记下缺的题',
  present_primary_view: '整理给你看的内容',
  compose_block: '画图',
};

const FALLBACKS: ReadonlyArray<[RegExp, string]> = [
  [/^propose_/, '提出建议'],
  [/^(?:query|get|search|read|find|expand|check)_/, '查资料'],
  [/^(?:write|author|update|generate|edit)_/, '整理内容'],
];

export function toolLabel(toolName: string): string {
  const known = TOOL_LABELS[toolName];
  if (known) return known;
  for (const [pattern, label] of FALLBACKS) if (pattern.test(toolName)) return label;
  return '一个步骤';
}

// YUK-1664 — what the companion is doing right now, said while a step runs, the way a person would
// say it. Every tool has its own short phrase; an unknown one falls back by what it does, so no
// internal name ever shows.
const ACTIVITY: Readonly<Record<string, string>> = {
  query_context: '在看你的学习概况',
  generate_goal_outline: '在列目标大纲',
  generate_question_candidate: '在出题',
  get_subject_graph_overview: '在看知识的整体结构',
  query_knowledge: '在查相关的知识点',
  query_events: '在看你最近的学习动态',
  query_records: '在翻你的学习记录',
  get_record_context: '在看这条记录',
  get_question_context: '在看这道题',
  query_mistakes: '在查你的错题',
  get_attempt_context: '在看你这次的作答',
  get_review_due: '在看今天该复习什么',
  get_learning_item_context: '在看这项学习内容',
  expand_knowledge_subgraph: '在找关联的知识点',
  find_knowledge_paths: '在找知识点之间的联系',
  search_bank: '在找题',
  read_bank: '在看题',
  check_bank: '在核对题目',
  propose_knowledge_edge: '在想怎么关联知识点',
  propose_knowledge_mutation: '在想怎么调整知识点',
  propose_learning_item_completion: '在想要不要标记学完',
  propose_learning_item_relearn: '在想要不要重新学',
  propose_learning_item_defer: '在想要不要推迟',
  propose_learning_item_archive: '在想要不要归档',
  author_question: '在出题',
  propose_question_edit: '在想怎么改这道题',
  attribute_mistake: '在分析错因',
  propose_variant: '在想换个什么变式',
  write_quiz: '在组一份练习',
  knowledge_mutation: '在想怎么调整学习内容',
  edit_question: '在改题',
  submit_review_answer: '在提交作答',
  reveal_answer: '在给参考答案',
  read_agent_notes: '在看之前记的笔记',
  write_agent_note: '在记一笔',
  file_bank_gap: '在记下缺的题',
  present_primary_view: '在整理给你看的内容',
  compose_block: '在画图',
};

const ACTIVITY_FALLBACKS: ReadonlyArray<[RegExp, string]> = [
  [/^propose_/, '在想个建议'],
  [/^(?:query|get|search|read|find|expand|check)_/, '在查资料'],
  [/^(?:write|author|update|generate|edit)_/, '在整理'],
];

export function toolActivity(toolName: string): string {
  const known = ACTIVITY[toolName];
  if (known) return known;
  for (const [pattern, phrase] of ACTIVITY_FALLBACKS) if (pattern.test(toolName)) return phrase;
  return '在忙这一步';
}
