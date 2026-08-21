import { DEFAULT_TASK_BUDGET, type TaskSpec } from '@/ai/task-spec';
import {
  type CopilotImplicitCorrectionIntent,
  CopilotImplicitCorrectionIntentSchema,
} from '../server/correction-contract';

export const copilotCorrectionIntentTaskSpec = {
  ownership: 'owned',
  definition: {
    kind: 'CopilotCorrectionIntentTask',
    description:
      'YUK-904 — bounded no-tool judgment that distinguishes an implicit correction of a prior Copilot reply from an ordinary follow-up and identifies every plausible prior-turn candidate.',
    defaultProvider: 'xiaomi',
    defaultModel: 'mimo-v2.5',
    budget: { ...DEFAULT_TASK_BUDGET, maxIterations: 1, timeout: 10_000 },
    needsToolCall: false,
    isMultimodal: false,
    allowedTools: [],
    structuredOutputSchema: CopilotImplicitCorrectionIntentSchema,
    prompt: {
      kind: 'inline',
      text: `你是 Copilot 的隐式更正意图判定器，不回答用户问题，也不调用工具。输入包含 user_message 与按时间排列的 prior_turn_candidates（每项只有 prior_turn_id 与 text）。

判断用户是否要求修改、替换、重写或纠正某一条既有 Copilot 回复。普通追问、继续讲解、要求再出一道相似题、基于历史内容提出新任务，都不是 correction。不要靠关键词机械判断；按整句语义判断。

若不是更正，严格输出：{"intent":"not_correction"}
若是更正，输出所有仍可能被用户指代的候选 id：{"intent":"correction","candidate_prior_turn_ids":["..."]}
只可复制输入里的 prior_turn_id。指代唯一时只给一个；无法排除多个时全部给出。严格只输出一个 JSON object，不要 rationale、confidence、markdown 或额外字段。`,
    },
  },
  outputSchema: CopilotImplicitCorrectionIntentSchema,
  parseText: (text: string) => CopilotImplicitCorrectionIntentSchema.parse(JSON.parse(text)),
} satisfies TaskSpec<unknown, CopilotImplicitCorrectionIntent>;
