import type { DerivationPolicyT } from '@/core/schema/derivation-policy';
import type { ReadDomainToolName } from './allowlists';
import type { ToolExecutionGateInput } from './types';

/** Reviewed existing data reads only. A future read tool is not implicitly admitted. */
export const ANSWER_ONLY_TOOL_NAMES = [
  'query_knowledge',
  'get_subject_graph_overview',
  'get_question_context',
  'search_bank',
  'read_bank',
  'query_memory_brief',
  'search_memory_facts',
  // Must stay mounted in the answer-only run; an unregistered name fails typecheck.
] as const satisfies readonly ReadDomainToolName[];
const answerOnlyTools: ReadonlySet<string> = new Set(ANSWER_ONLY_TOOL_NAMES);
export const ANSWER_ONLY_TOOL_DENIAL =
  '仅用于本次回答：可读取已有学习资料，不创建练习、笔记或计划。';

export function derivationToolDenial(
  policy: DerivationPolicyT,
  tool: ToolExecutionGateInput,
): string | undefined {
  // Crisis turns run only support templates; this guards new execution paths that
  // bypass the worker's deterministic branch.
  if (policy === 'crisis') {
    return '此消息已转入支持回应模式：本轮不执行任何学习工具。';
  }
  return policy === 'answer_only' && (tool.effect !== 'read' || !answerOnlyTools.has(tool.name))
    ? ANSWER_ONLY_TOOL_DENIAL
    : undefined;
}
