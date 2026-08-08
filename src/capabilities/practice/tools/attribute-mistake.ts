import {
  getFailureAttemptWithReasoningTraceById,
  getJudgeForAttempt,
} from '@/capabilities/practice/server/attempt-events';
import { createFailureLearning } from '@/capabilities/practice/server/failure-learning';
import { makePracticeTaskRunFn } from '@/capabilities/practice/server/task-runtime';
import type { Db } from '@/db/client';
import { z } from 'zod';
import type { DomainTool, ToolContext } from './types';

const TEXT_EXCERPT_MAX = 180;

function excerpt(value: string | null | undefined, max = TEXT_EXCERPT_MAX): string {
  const text = (value ?? '').replace(/\s+/g, ' ').trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

const AttributeMistakeInputSchema = z.object({
  attempt_event_id: z.string().min(1),
});

const AttributeMistakeOutputSchema = z.object({
  status: z.enum(['written', 'skipped:existing_judge', 'skipped:not_failure_attempt', 'failed']),
  judge_event_id: z.string().optional(),
  cause: z
    .object({
      primary_category: z.string(),
      secondary_categories: z.array(z.string()),
      confidence: z.number().nullable(),
      analysis_excerpt: z.string(),
    })
    .optional(),
  reason: z.string().optional(),
});

type AttributeMistakeInput = z.infer<typeof AttributeMistakeInputSchema>;
type AttributeMistakeOutput = z.infer<typeof AttributeMistakeOutputSchema>;

function judgeOutput(
  status: 'written' | 'skipped:existing_judge',
  judge: NonNullable<Awaited<ReturnType<typeof getJudgeForAttempt>>>,
): AttributeMistakeOutput {
  return {
    status,
    judge_event_id: judge.judge_event_id,
    cause: {
      primary_category: judge.cause.primary_category,
      secondary_categories: judge.cause.secondary_categories ?? [],
      confidence: judge.cause.confidence ?? null,
      analysis_excerpt: excerpt(judge.cause.analysis_md),
    },
  };
}

async function questionNotFoundOutput(
  db: Db,
  attemptEventId: string,
): Promise<AttributeMistakeOutput> {
  const loaded = await getFailureAttemptWithReasoningTraceById(db, attemptEventId);
  return {
    status: 'failed',
    reason: loaded ? `question not found: ${loaded.failure.question_id}` : 'question not found',
  };
}

async function attributeMistakeExecute(
  ctx: ToolContext,
  raw: AttributeMistakeInput,
): Promise<AttributeMistakeOutput> {
  const input = AttributeMistakeInputSchema.parse(raw);
  const failureLearning = createFailureLearning({
    db: ctx.db,
    runTaskFn: makePracticeTaskRunFn(ctx.db, {
      signal: ctx.signal,
      parentTaskRunId: ctx.taskRunId,
      ...(ctx.providerSessionDeadlineAt !== undefined
        ? { providerSessionDeadlineAt: ctx.providerSessionDeadlineAt }
        : {}),
    }),
  });
  const result = await failureLearning.attribute({ attemptEventId: input.attempt_event_id });

  if (result.status === 'skipped') {
    if (result.reason === 'question_not_found') {
      return questionNotFoundOutput(ctx.db, input.attempt_event_id);
    }
    return { status: 'skipped:not_failure_attempt' };
  }
  if (result.status === 'failed_permanent' || result.status === 'failed_retryable') {
    return { status: 'failed' };
  }

  const judge = await getJudgeForAttempt(ctx.db, input.attempt_event_id);
  if (!judge) {
    return { status: 'failed', reason: 'AttributionTask completed without writing a judge event' };
  }
  return judgeOutput(result.status === 'written' ? 'written' : 'skipped:existing_judge', judge);
}

export const attributeMistakeTool: DomainTool<AttributeMistakeInput, AttributeMistakeOutput> = {
  name: 'attribute_mistake',
  description:
    'Run the existing AttributionTask path for one failure attempt and append a judge event if no active judge exists. The caller cannot provide a cause.',
  effect: 'write',
  inputSchema: AttributeMistakeInputSchema,
  outputSchema: AttributeMistakeOutputSchema,
  costClass: 'cheap_llm',
  execute: attributeMistakeExecute,
  summarize(input, output) {
    return `attribute ${input.attempt_event_id.slice(0, 8)}: ${output.status}${output.cause ? ` (${output.cause.primary_category})` : ''}`;
  },
  mirrorEvent: 'when_causal',
};
