import { DEFAULT_TASK_BUDGET, type TaskSpec } from '@/ai/task-spec';
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

export const backtraceJudgeTaskSpec = {
  ownership: 'owned',
  definition: {
    kind: 'BacktraceJudgeTask',
    description: '判断历史作答的具体相似错法与相似解法',
    budget: { ...DEFAULT_TASK_BUDGET, timeout: 600_000, maxIterations: 3 },
    needsToolCall: true,
    isMultimodal: false,
    allowedTools: ['mcp__structured_output__submit'],
    context: { view: 'none', reason: '只比较提供的本人历史作答，不判分。' },
    structuredOutputMode: 'tool',
    structuredOutputSchema: BacktraceDecisions,
    prompt: {
      kind: 'inline',
      text: '每候选一条带outcome。same_method须本人原文方法，失败不是成功解法；needs_this_method限过去成功的方法；inferred不作依据。具体公式/条件相同才specific，审题单位粗心只能broad。evidence.now/prior逐字摘insight的方法证据、错误或needed_method，why不加新算法。shared_step仅已有步骤键，无依据null/not_similar。不判分，submit全部matches。',
    },
  },
  outputSchema: BacktraceDecisions,
  parseText: (text) => parseTaskOutput(text, 'BacktraceJudgeTask', BacktraceDecisions),
} satisfies TaskSpec<unknown, unknown>;
