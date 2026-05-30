// YUK-81 / Foundation D M1 Lane C
//
// `get_attempt_context` — composite reader for a single failure attempt.
// Returns the attempt event + question contract + judged cause +
// per-question timeline + any LearningRecord rows that linked to it.
//
// This is the high-frequency Copilot path for "explain why I got this
// wrong". Bundling the joins server-side keeps the LLM context shallow:
// one tool call instead of four.

import { question } from '@/db/schema';
import { effectiveCauseForFailureAttempt } from '@/server/events/cause-policy';
import { getFailureAttemptById, getQuestionTimeline } from '@/server/events/queries';
import { listLearningRecords } from '@/server/records/queries';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
// P5.1 / YUK-143 — courtesy default (10) centralized in budgets.ts;
// byte-unchanged from the prior inline literal.
import { TOOL_COURTESY_DEFAULTS } from './budgets';
import type { DomainTool, ToolContext } from './types';

const InputSchema = z.object({
  attemptEventId: z.string().min(1),
  timelineLimit: z.number().int().positive().max(50).optional(),
});

const QuestionInfoSchema = z.object({
  id: z.string(),
  kind: z.string(),
  prompt_md: z.string(),
  reference_md: z.string().nullable(),
  knowledge_ids: z.array(z.string()),
});

const CauseSchema = z.object({
  source: z.enum(['user', 'agent']),
  primary_category: z.string(),
  secondary_categories: z.array(z.string()),
  analysis_md: z.string().nullable(),
  user_notes: z.string().nullable(),
  confidence: z.number().nullable(),
});

const TimelineEntrySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('attempt'),
    event_id: z.string(),
    created_at: z.string(),
    outcome: z.string(),
    duration_ms: z.number().nullable(),
    cause: z
      .object({
        primary: z.string(),
        confidence: z.number().nullable(),
      })
      .nullable(),
  }),
  z.object({
    kind: z.literal('review'),
    event_id: z.string(),
    created_at: z.string(),
    fsrs_rating: z.string(),
    outcome: z.string(),
    duration_ms: z.number().nullable(),
  }),
]);

const LinkedRecordSchema = z.object({
  id: z.string(),
  kind: z.string(),
  title: z.string().nullable(),
  content_md: z.string(),
  created_at: z.string(),
});

const OutputSchema = z.object({
  attempt: z.object({
    event_id: z.string(),
    question_id: z.string(),
    answer_md: z.string().nullable(),
    answer_image_refs: z.array(z.string()),
    referenced_knowledge_ids: z.array(z.string()),
    created_at: z.string(),
  }),
  question: QuestionInfoSchema.nullable(),
  cause: CauseSchema.nullable(),
  timeline: z.array(TimelineEntrySchema),
  linked_records: z.array(LinkedRecordSchema),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

const DESCRIPTION = [
  'Fetch the full context for one failure attempt event. Use to explain why the user got a',
  'question wrong: the attempt payload, the question contract, the resolved cause (user > agent),',
  'the per-question timeline (other attempts + reviews), and any linked LearningRecord rows.',
  '',
  'Input:',
  '- attemptEventId: the id of the attempt event (must be action=attempt subject_kind=question outcome=failure).',
  '- timelineLimit: how many timeline entries to return (1–50, default 10).',
  '',
  'Returns null question / empty timeline / empty records when the joins yield nothing,',
  'rather than throwing — so the LLM can still describe a partial state.',
].join('\n');

async function execute(ctx: ToolContext, raw: Input): Promise<Output> {
  const input = InputSchema.parse(raw);
  const failure = await getFailureAttemptById(ctx.db, input.attemptEventId);

  if (!failure) {
    return OutputSchema.parse({
      attempt: {
        event_id: input.attemptEventId,
        question_id: '',
        answer_md: null,
        answer_image_refs: [],
        referenced_knowledge_ids: [],
        created_at: new Date(0).toISOString(),
      },
      question: null,
      cause: null,
      timeline: [],
      linked_records: [],
    });
  }

  const cause = effectiveCauseForFailureAttempt(failure);
  const questionRows = await ctx.db
    .select({
      id: question.id,
      kind: question.kind,
      prompt_md: question.prompt_md,
      reference_md: question.reference_md,
      knowledge_ids: question.knowledge_ids,
    })
    .from(question)
    .where(eq(question.id, failure.question_id))
    .limit(1);

  const questionRow = questionRows[0] ?? null;
  const timeline = await getQuestionTimeline(
    ctx.db,
    failure.question_id,
    input.timelineLimit ?? TOOL_COURTESY_DEFAULTS.get_attempt_context,
  );

  const records = await listLearningRecords(ctx.db, {
    attempt_event_id: failure.attempt_event_id,
    limit: 25,
  });

  return OutputSchema.parse({
    attempt: {
      event_id: failure.attempt_event_id,
      question_id: failure.question_id,
      answer_md: failure.answer_md,
      answer_image_refs: failure.answer_image_refs,
      referenced_knowledge_ids: failure.referenced_knowledge_ids,
      created_at: failure.created_at.toISOString(),
    },
    question: questionRow
      ? {
          id: questionRow.id,
          kind: questionRow.kind,
          prompt_md: questionRow.prompt_md,
          reference_md: questionRow.reference_md ?? null,
          knowledge_ids: questionRow.knowledge_ids ?? [],
        }
      : null,
    cause: cause
      ? {
          source: cause.source,
          primary_category: cause.primary_category,
          secondary_categories: cause.secondary_categories,
          analysis_md: cause.analysis_md,
          user_notes: cause.user_notes,
          confidence: cause.confidence,
        }
      : null,
    timeline: timeline.map((entry) =>
      entry.kind === 'attempt'
        ? {
            kind: 'attempt' as const,
            event_id: entry.event_id,
            created_at: entry.created_at.toISOString(),
            outcome: entry.outcome,
            duration_ms: entry.duration_ms,
            cause: entry.cause
              ? { primary: entry.cause.primary, confidence: entry.cause.confidence }
              : null,
          }
        : {
            kind: 'review' as const,
            event_id: entry.event_id,
            created_at: entry.created_at.toISOString(),
            fsrs_rating: entry.fsrs_rating,
            outcome: entry.outcome,
            duration_ms: entry.duration_ms,
          },
    ),
    linked_records: records.map((r) => ({
      id: r.id,
      kind: r.kind,
      title: r.title ?? null,
      content_md: r.content_md,
      created_at: r.created_at.toISOString(),
    })),
  });
}

function summarize(input: Input, output: Output): string {
  const qid = output.attempt.question_id || '(missing)';
  const tl = output.timeline.length;
  const rec = output.linked_records.length;
  const cause = output.cause?.primary_category ?? 'no-cause';
  return `attempt ${input.attemptEventId.slice(0, 8)} · q=${qid.slice(0, 8)} · cause=${cause} · timeline=${tl} · records=${rec}`;
}

export const getAttemptContextTool: DomainTool<Input, Output> = {
  name: 'get_attempt_context',
  description: DESCRIPTION,
  effect: 'read',
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  costClass: 'local',
  execute,
  summarize,
  mirrorEvent: 'when_user_visible',
};
