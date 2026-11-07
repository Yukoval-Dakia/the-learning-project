import { DEFAULT_TASK_BUDGET, type TaskSpec } from '@/ai/task-spec';
import {
  SolutionAnnotationOutput,
  type SolutionAnnotationOutputT,
} from '@/core/schema/solution-annotation';
import { parseTaskOutput } from '@/kernel/parse-task-output';

// Background solution-method annotation for an ingested question. Deliberately
// narrower than SolutionGenerateTask: this answers "how is this solved", not "what
// is the answer", so its output never becomes an answer key or a grading signal.
function buildPrompt(): string {
  return `你是题目解法标注器。输入 { prompt_md, kind, knowledge_label } —— prompt_md 是题面，kind 是题型，knowledge_label 是已归属知识点名称（可能为空）。

任务：写出这道题的解法标注，供学习者在题目旁快速理解「这类题怎么想、怎么做」。
1. method_md：解法名称与核心思路，一行，不超过 60 字。例如「用楞次定律判断感应电流方向」「配方法求二次函数顶点」。
2. steps_md：按实际执行顺序列出 1–6 个关键步骤，每一步一句短话（不超过 80 字），写清这一步做什么、为什么。不是完整解答，不逐字演算。
3. confidence：0 到 1 的 JSON number，表示你对这份解法标注的把握。

硬规则：
- 不要给出最终答案，不要写答案数值或选项判定；步骤里只出现为说明方法所必需的中间量。
- 只做解法概述，不写完整解题过程，不代替学习者作答。
- 题面信息不足时，仍给出最接近的通用解法，并降低 confidence；不要编造题面没有的条件。
- 严格 JSON 输出，不带 markdown 代码块，shape：{"method_md":"...","steps_md":["..."],"confidence":0.0}`;
}

export const ingestionSolutionAnnotationTaskSpec = {
  ownership: 'owned',
  definition: {
    kind: 'IngestionSolutionAnnotationTask',
    description:
      'YUK-1994 slice 3 — background solution-method annotation for an ingested question. Output = { method_md, steps_md, confidence }: how the question is solved, never the final answer, never an answer key and never a grading input. Stored on question.metadata.solution_annotation by the ingestion annotation backfill.',
    // Single short structured reply; no measured tail yet. 180s clears the
    // per-question annotation latency seen in the acceptance run.
    budget: { ...DEFAULT_TASK_BUDGET, maxIterations: 1, timeout: 180_000 },
    needsToolCall: false,
    isMultimodal: false,
    allowedTools: [],
    context: {
      view: 'none',
      reason: '解法标注只按本题题面与知识点，不读学习者历史。',
    },
    prompt: { kind: 'inline', text: buildPrompt() },
  },
  outputSchema: SolutionAnnotationOutput,
  parseText: (text) =>
    parseTaskOutput(text, 'IngestionSolutionAnnotationTask', SolutionAnnotationOutput),
} satisfies TaskSpec<unknown, SolutionAnnotationOutputT>;
