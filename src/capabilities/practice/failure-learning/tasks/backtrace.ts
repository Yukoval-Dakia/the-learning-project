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
      text: '只依据提供的本人作答与过程描述方法；参考解只用于 needed_method，绝不能冒充本人方法。看不到过程则 method=null，写明原因。错法须点名具体公式、关系、步骤及其适用条件，不预设分类。用户错因优先且保留原话。没有错误则 mechanism=null。quote 仅逐字引用本人文本。调用 submit 一次提交整个描述。',
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
      text: '对每个候选给一条判定。点名共享的具体公式、关系、步骤和适用条件才是 specific。审题、单位、粗心等泛化习惯只能 broad。same_mechanism 为同一错法；same_method 为本人用过同一方法；needs_this_method 为过去本人用过当前参考所需方法；无关为 not_similar。不重新判分，不隐藏宽泛匹配。shared_step 只能引用输入已有步骤键，无可指认步骤则 null。一次 submit 提交全部 matches。',
    },
  },
  outputSchema: BacktraceDecisions,
  parseText: (text) => parseTaskOutput(text, 'BacktraceJudgeTask', BacktraceDecisions),
} satisfies TaskSpec<unknown, unknown>;
