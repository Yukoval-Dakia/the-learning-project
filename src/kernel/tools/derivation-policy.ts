import type { DerivationPolicyT } from '@/core/schema/derivation-policy';
import type { ToolExecutionGateInput } from './types';

/** Reviewed existing data reads only. A future read tool is not implicitly admitted. */
export const ANSWER_ONLY_TOOL_NAMES = [
  'query_knowledge',
  'get_subject_graph_overview',
  'get_question_context',
  'query_questions',
  'query_memory_brief',
  'search_memory_facts',
] as const;
const answerOnlyTools: ReadonlySet<string> = new Set(ANSWER_ONLY_TOOL_NAMES);
export const ANSWER_ONLY_TOOL_DENIAL =
  '仅用于本次回答：可读取已有学习资料，不创建练习、笔记或计划。';

export function derivationToolDenial(
  policy: DerivationPolicyT,
  tool: ToolExecutionGateInput,
): string | undefined {
  return policy === 'answer_only' && (tool.effect !== 'read' || !answerOnlyTools.has(tool.name))
    ? ANSWER_ONLY_TOOL_DENIAL
    : undefined;
}
