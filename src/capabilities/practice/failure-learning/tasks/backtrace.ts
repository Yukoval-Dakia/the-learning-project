import { DEFAULT_TASK_BUDGET, type StructuredSubmitUnitPlan, type TaskSpec } from '@/ai/task-spec';
import { AttemptDescription, BacktraceDecisions } from '@/core/schema/backtrace';
import { parseTaskOutput } from '@/kernel/parse-task-output';

export const attemptInsightTaskSpec = {
  ownership: 'owned',
  definition: {
    kind: 'AttemptInsightTask',
    description: '描述学习者本次具体错法与本人解法',
    budget: { ...DEFAULT_TASK_BUDGET, timeout: 600_000, maxIterations: 3 },
    needsToolCall: true,
    isMultimodal: false,
    allowedTools: ['mcp__structured_output__submit'],
    context: { view: 'none', reason: '只读冻结作答证据，不读取画像。' },
    structuredOutputMode: 'tool',
    structuredOutputSchema: AttemptDescription,
    prompt: {
      kind: 'inline',
      text: '只据reasoning_trace；没过程则null。本人明写标evidence，evidence_quotes/steps.quote逐字摘原文；没明说的算法仅标inferred，不冒充本人方法。参考解只放needed_method。具体错法点名步骤和条件，用户错因保留原话；无错则mechanism=null。submit整个描述。',
    },
  },
  outputSchema: AttemptDescription,
  parseText: (text) => parseTaskOutput(text, 'AttemptInsightTask', AttemptDescription),
} satisfies TaskSpec<unknown, unknown>;

const Match = BacktraceDecisions.shape.matches.element;

function candidateIds(input: unknown): string[] {
  if (
    !input ||
    typeof input !== 'object' ||
    !('candidates' in input) ||
    !Array.isArray(input.candidates)
  )
    return [];
  return input.candidates.map((x) => x.attempt_event_id);
}

// Longest observed completed single-part run: 158.5s, including one correction.
// tlp-docs/audit/yuk1941-solve-tokens/prior-diagnosis.md; reserve 60s for closure.
export const backtraceJudgeTimeoutMs = (input: unknown) =>
  candidateIds(input).length * 160_000 + 60_000;

export const backtraceJudgeTaskSpec = {
  ownership: 'owned',
  definition: {
    kind: 'BacktraceJudgeTask',
    description: '判断历史作答的具体相似错法与相似解法',
    budget: { ...DEFAULT_TASK_BUDGET, timeout: 16 * 160_000 + 60_000, maxIterations: 3 },
    needsToolCall: true,
    isMultimodal: false,
    allowedTools: ['mcp__structured_output__submit'],
    context: { view: 'none', reason: '只比较提供的本人历史作答，不判分。' },
    structuredOutputMode: 'tool',
    structuredSubmitSchema: () => Match,
    structuredSubmitUnits: (input: unknown): StructuredSubmitUnitPlan | undefined => {
      const ids = candidateIds(input);
      if (
        !ids.length ||
        ids.some((id) => typeof id !== 'string') ||
        new Set(ids).size !== ids.length
      )
        return undefined;
      return {
        expectedUnitIds: ids,
        unitOf: (submitted) => ({
          id: Match.safeParse(submitted).data?.attempt_event_id,
          unit: submitted,
        }),
        validateUnit: (submitted) =>
          Match.safeParse(submitted).success ? [] : ['match: must match the declared schema'],
        assemble: (units) => ({ matches: [...units] }),
      };
    },
    structuredOutputSchema: BacktraceDecisions,
    prompt: {
      kind: 'inline',
      text: '逐候选submit对象，带outcome。same_method须本人原文方法，失败不是成功解法；needs_this_method限过去成功的方法；inferred不作依据。具体公式/条件相同才specific，审题单位粗心只能broad。evidence.now/prior逐字摘insight的方法证据、错误或needed_method，why不加新算法。shared_step仅已有步骤键，无依据null/not_similar。不判分，不重交已接受候选。',
    },
  },
  outputSchema: BacktraceDecisions,
  parseText: (text) => parseTaskOutput(text, 'BacktraceJudgeTask', BacktraceDecisions),
} satisfies TaskSpec<unknown, unknown>;
