// YUK-81 / Foundation D M1 Lane C; YUK-832 evidence-reader hardening.
//
// `get_attempt_context` is the exact-id activity reader for answer events. It
// preserves the historical tool/input name, but now distinguishes lookup
// failure modes and supports both attempt and review events. Same-question
// history is explicitly non-causal; causal evidence comes from getEventChain.

import { INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE } from '@/core/schema/intervention';
import { question } from '@/db/schema';
import { type EnvelopedEvent, getEventById, getEventChain } from '@/kernel/events';
import { effectiveCauseForFailureAttempt } from '@/server/events/cause-policy';
import { getFailureAttemptById, getQuestionTimeline } from '@/server/events/queries';
import { listLearningRecords } from '@/server/records/queries';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { TOOL_COURTESY_DEFAULTS } from './budgets';
import type { DomainTool, ToolContext } from './types';

const InputSchema = z.object({
  attemptEventId: z.string().min(1),
  timelineLimit: z.number().int().positive().max(50).optional(),
  causalLimit: z.number().int().positive().max(50).optional(),
});

const FsrsStateEvidenceSchema = z.object({
  due: z.string().datetime(),
  stability: z.number(),
  difficulty: z.number(),
  elapsed_days: z.number().optional(),
  scheduled_days: z.number(),
  learning_steps: z.number(),
  reps: z.number().int(),
  lapses: z.number().int(),
  state: z.enum(['new', 'learning', 'review', 'relearning']),
  last_review: z.string().datetime().nullable(),
});

const FsrsEvidenceSchema = z.object({
  rating: z.enum(['again', 'hard', 'good']),
  subject_kind: z.enum(['question', 'knowledge']).nullable(),
  subject_ids: z.array(z.string()),
  state_after: FsrsStateEvidenceSchema,
  state_after_by_subject: z.array(
    z.object({
      subject_kind: z.enum(['question', 'knowledge']),
      subject_id: z.string(),
      state: FsrsStateEvidenceSchema,
      due_at: z.string().datetime(),
    }),
  ),
});

const AnswerActivitySchema = z.object({
  event_id: z.string(),
  dispatch_seq: z.number().int().positive(),
  action: z.enum(['attempt', 'review']),
  outcome: z.enum(['success', 'failure', 'partial']),
  question_id: z.string(),
  answer_md: z.string().nullable(),
  answer_image_refs: z.array(z.string()),
  referenced_knowledge_ids: z.array(z.string()),
  created_at: z.string().datetime(),
  fsrs: FsrsEvidenceSchema.nullable(),
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
  event_id: z.string(),
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
    dispatch_seq: z.number().int().positive(),
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
    dispatch_seq: z.number().int().positive(),
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

const EventEvidenceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('judge'),
    score: z.number().nullable(),
    coarse_outcome: z.string().nullable(),
    referenced_knowledge_ids: z.array(z.string()),
  }),
  z.object({
    kind: z.literal('grading_checkpoint'),
    attempt_event_id: z.string(),
    segment: z.enum(['theta', 'fsrs']),
  }),
  z.object({
    kind: z.literal('state_snapshot'),
    attempt_event_id: z.string(),
    theta_snapshots: z.array(
      z.object({
        knowledge_id: z.string(),
        before_present: z.boolean(),
        before_theta_hat: z.number().nullable(),
        after_theta_hat: z.number(),
      }),
    ),
    fsrs_snapshots: z.array(
      z.object({
        subject_kind: z.enum(['question', 'knowledge']),
        subject_id: z.string(),
        before: FsrsStateEvidenceSchema.nullable(),
        after: FsrsStateEvidenceSchema,
      }),
    ),
  }),
]);

const CausalEventRefSchema = z.object({
  event_id: z.string(),
  dispatch_seq: z.number().int().positive(),
  action: z.string(),
  subject_kind: z.string(),
  subject_id: z.string(),
  outcome: z.string().nullable(),
  caused_by_event_id: z.string().nullable(),
  created_at: z.string().datetime(),
  correction_state: z.enum(['active', 'retracted', 'marked_wrong', 'superseded']),
  correction_event_id: z.string().nullable(),
  replacement_event_id: z.string().nullable(),
  evidence: EventEvidenceSchema.nullable(),
});

const ExactEventIdentitySchema = CausalEventRefSchema;

const OutputSchema = z.object({
  lookup: z.object({
    requested_event_id: z.string(),
    status: z.enum(['found', 'not_found', 'unsupported_event', 'inactive']),
    observed: ExactEventIdentitySchema.nullable(),
  }),
  // Compatibility: successful lookups retain the historical `attempt` key.
  // It is nullable instead of fabricating an epoch sentinel when lookup fails.
  attempt: AnswerActivitySchema.nullable(),
  question: QuestionInfoSchema.nullable(),
  question_availability: z.enum([
    'found',
    'not_found',
    'redacted_intervention_diagnostic',
    'not_resolved',
  ]),
  cause: CauseSchema.nullable(),
  timeline: z.array(TimelineEntrySchema),
  timeline_scope: z.literal('same_question_context_noncausal'),
  timeline_coverage: z.object({
    returned_count: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
    has_more: z.boolean().nullable(),
    complete: z.boolean().nullable(),
  }),
  causal_neighborhood: z.object({
    parent: CausalEventRefSchema.nullable(),
    direct_children: z.array(CausalEventRefSchema),
    relation_semantics: z.literal('direct_children_only'),
    coverage: z.object({
      returned_count: z.number().int().nonnegative(),
      limit: z.number().int().positive(),
      total_direct_children: z.number().int().nonnegative().nullable(),
      has_more: z.boolean().nullable(),
      complete: z.boolean().nullable(),
    }),
  }),
  linked_records: z.array(LinkedRecordSchema),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

const DESCRIPTION = [
  'Fetch exact evidence for one answer event id. Supports action=attempt and action=review,',
  'including successful reviews; never infers an action from id text and never fabricates a row.',
  '',
  '- lookup.status distinguishes found, not_found, unsupported_event, and inactive.',
  '- attempt is the compatible answer-activity field and includes exact action/outcome/dispatch_seq.',
  '- causal_neighborhood contains the exact parent and direct children only. It does not call',
  '  same-question history causal. Check coverage and each event correction_state before treating',
  '  any parent/child evidence as current.',
  '- timeline is same-question context only, explicitly non-causal, with bounded coverage.',
  '- review evidence includes FSRS rating, subject provenance, and per-subject schedule states.',
  '- question_availability distinguishes missing data from protected diagnostic redaction.',
].join('\n');

function causedByEventId(value: EnvelopedEvent): string | null {
  return 'caused_by_event_id' in value && typeof value.caused_by_event_id === 'string'
    ? value.caused_by_event_id
    : null;
}

function eventEvidence(value: EnvelopedEvent): z.infer<typeof EventEvidenceSchema> | null {
  if (value.action === 'judge') {
    const payload = value.payload as {
      score?: number;
      coarse_outcome?: string;
      referenced_knowledge_ids?: string[];
    };
    return {
      kind: 'judge',
      score: payload.score ?? null,
      coarse_outcome: payload.coarse_outcome ?? null,
      referenced_knowledge_ids: payload.referenced_knowledge_ids ?? [],
    };
  }
  if (value.action === 'experimental:grading_checkpoint') {
    const payload = value.payload as { attempt_event_id: string; segment: 'theta' | 'fsrs' };
    return {
      kind: 'grading_checkpoint',
      attempt_event_id: payload.attempt_event_id,
      segment: payload.segment,
    };
  }
  if (value.action === 'experimental:state_snapshot') {
    const payload = value.payload as {
      attempt_event_id: string;
      theta_snapshots: Array<{
        kc_id: string;
        before: number | { theta_hat: number } | null;
        after: number;
      }>;
      fsrs_snapshots: Array<{
        subject_kind: 'question' | 'knowledge';
        subject_id: string;
        before: Parameters<typeof fsrsStateEvidence>[0] | null;
        after: Parameters<typeof fsrsStateEvidence>[0];
      }>;
    };
    return {
      kind: 'state_snapshot',
      attempt_event_id: payload.attempt_event_id,
      theta_snapshots: payload.theta_snapshots.map((snapshot) => ({
        knowledge_id: snapshot.kc_id,
        before_present: snapshot.before !== null,
        before_theta_hat:
          typeof snapshot.before === 'number'
            ? snapshot.before
            : (snapshot.before?.theta_hat ?? null),
        after_theta_hat: snapshot.after,
      })),
      fsrs_snapshots: payload.fsrs_snapshots.map((snapshot) => ({
        subject_kind: snapshot.subject_kind,
        subject_id: snapshot.subject_id,
        before: snapshot.before ? fsrsStateEvidence(snapshot.before) : null,
        after: fsrsStateEvidence(snapshot.after),
      })),
    };
  }
  return null;
}

function eventRef(value: EnvelopedEvent): z.infer<typeof CausalEventRefSchema> {
  return {
    event_id: value.id,
    dispatch_seq: value.dispatch_seq,
    action: value.action,
    subject_kind: value.subject_kind,
    subject_id: value.subject_id,
    outcome: value.outcome ?? null,
    caused_by_event_id: causedByEventId(value),
    created_at: value.created_at.toISOString(),
    correction_state: value.correction_status.state,
    correction_event_id: value.correction_status.correction_event_id,
    replacement_event_id: value.correction_status.replacement_event_id,
    evidence: eventEvidence(value),
  };
}

function fsrsStateEvidence(value: {
  due: Date;
  stability: number;
  difficulty: number;
  elapsed_days?: number;
  scheduled_days: number;
  learning_steps: number;
  reps: number;
  lapses: number;
  state: 'new' | 'learning' | 'review' | 'relearning';
  last_review: Date | null;
}): z.infer<typeof FsrsStateEvidenceSchema> {
  return {
    ...value,
    due: value.due.toISOString(),
    last_review: value.last_review?.toISOString() ?? null,
  };
}

function answerActivity(value: EnvelopedEvent): z.infer<typeof AnswerActivitySchema> | null {
  if (value.subject_kind !== 'question') return null;
  const outcome = value.outcome;
  if (outcome !== 'success' && outcome !== 'failure' && outcome !== 'partial') return null;
  if (value.action === 'attempt') {
    const payload = value.payload as {
      answer_md: string | null;
      answer_image_refs: string[];
      referenced_knowledge_ids: string[];
    };
    return {
      event_id: value.id,
      dispatch_seq: value.dispatch_seq,
      action: 'attempt',
      outcome,
      question_id: value.subject_id,
      answer_md: payload.answer_md,
      answer_image_refs: payload.answer_image_refs,
      referenced_knowledge_ids: payload.referenced_knowledge_ids,
      created_at: value.created_at.toISOString(),
      fsrs: null,
    };
  }
  if (value.action !== 'review') return null;
  const payload = value.payload as {
    fsrs_rating: 'again' | 'hard' | 'good';
    fsrs_subject_kind?: 'question' | 'knowledge';
    fsrs_subject_ids?: string[];
    fsrs_state_after: Parameters<typeof fsrsStateEvidence>[0];
    fsrs_state_after_by_subject?: Array<{
      subject_kind: 'question' | 'knowledge';
      subject_id: string;
      state: Parameters<typeof fsrsStateEvidence>[0];
      due_at: Date;
    }>;
    user_response_md: string | null;
    answer_image_refs?: string[];
    referenced_knowledge_ids: string[];
  };
  return {
    event_id: value.id,
    dispatch_seq: value.dispatch_seq,
    action: 'review',
    outcome,
    question_id: value.subject_id,
    answer_md: payload.user_response_md,
    answer_image_refs: payload.answer_image_refs ?? [],
    referenced_knowledge_ids: payload.referenced_knowledge_ids,
    created_at: value.created_at.toISOString(),
    fsrs: {
      rating: payload.fsrs_rating,
      subject_kind: payload.fsrs_subject_kind ?? null,
      subject_ids: payload.fsrs_subject_ids ?? [],
      state_after: fsrsStateEvidence(payload.fsrs_state_after),
      state_after_by_subject: (payload.fsrs_state_after_by_subject ?? []).map((row) => ({
        subject_kind: row.subject_kind,
        subject_id: row.subject_id,
        state: fsrsStateEvidence(row.state),
        due_at: row.due_at.toISOString(),
      })),
    },
  };
}

function emptyOutput(
  input: Input,
  status: 'not_found' | 'unsupported_event' | 'inactive',
  observed: z.infer<typeof ExactEventIdentitySchema> | null,
  causal: Output['causal_neighborhood'],
): Output {
  const timelineLimit = input.timelineLimit ?? TOOL_COURTESY_DEFAULTS.get_attempt_context;
  return OutputSchema.parse({
    lookup: { requested_event_id: input.attemptEventId, status, observed },
    attempt: null,
    question: null,
    question_availability: 'not_resolved',
    cause: null,
    timeline: [],
    timeline_scope: 'same_question_context_noncausal',
    timeline_coverage: {
      returned_count: 0,
      limit: timelineLimit,
      // No supported question activity was resolved, so an empty timeline is
      // not evidence that no same-question context exists.
      has_more: null,
      complete: null,
    },
    causal_neighborhood: causal,
    linked_records: [],
  });
}

async function execute(ctx: ToolContext, raw: Input): Promise<Output> {
  const input = InputSchema.parse(raw);
  const timelineLimit = input.timelineLimit ?? TOOL_COURTESY_DEFAULTS.get_attempt_context;
  const causalLimit = input.causalLimit ?? TOOL_COURTESY_DEFAULTS.get_attempt_context;
  const focal = await getEventById(ctx.db, input.attemptEventId);

  const noCausal: Output['causal_neighborhood'] = {
    parent: null,
    direct_children: [],
    relation_semantics: 'direct_children_only',
    coverage: {
      returned_count: 0,
      limit: causalLimit,
      // caused_by_event_id is intentionally not a foreign key. A missing focal
      // row therefore cannot prove that no dangling direct children exist.
      total_direct_children: null,
      has_more: null,
      complete: null,
    },
  };
  if (!focal) return emptyOutput(input, 'not_found', null, noCausal);

  const chain = await getEventChain(ctx.db, focal.id);
  const directChildren = chain.caused_events.slice(0, causalLimit);
  const causal: Output['causal_neighborhood'] = {
    parent: chain.caused_by ? eventRef(chain.caused_by) : null,
    direct_children: directChildren.map(eventRef),
    relation_semantics: 'direct_children_only',
    coverage: {
      returned_count: directChildren.length,
      limit: causalLimit,
      total_direct_children: chain.caused_events.length,
      has_more: chain.caused_events.length > directChildren.length,
      complete: chain.caused_events.length <= directChildren.length,
    },
  };
  const observed: z.infer<typeof ExactEventIdentitySchema> = eventRef(focal);
  const activity = answerActivity(focal);
  if (!activity) return emptyOutput(input, 'unsupported_event', observed, causal);
  if (focal.correction_status.state !== 'active') {
    return emptyOutput(input, 'inactive', observed, causal);
  }

  const questionRows = await ctx.db
    .select({
      id: question.id,
      kind: question.kind,
      prompt_md: question.prompt_md,
      reference_md: question.reference_md,
      knowledge_ids: question.knowledge_ids,
      source: question.source,
    })
    .from(question)
    .where(eq(question.id, activity.question_id))
    .limit(1);
  const questionRow = questionRows[0] ?? null;
  const questionAvailability = !questionRow
    ? ('not_found' as const)
    : questionRow.source === INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE
      ? ('redacted_intervention_diagnostic' as const)
      : ('found' as const);

  // Fetch one look-ahead row where the shared reader's 50-row cap permits it.
  // At exactly 50 returned rows the reader cannot prove whether more exist, so
  // coverage is explicitly unknown rather than a false exhaustive claim.
  const timelineFetchLimit = Math.min(timelineLimit + 1, 50);
  const timelineCandidates = await getQuestionTimeline(
    ctx.db,
    activity.question_id,
    timelineFetchLimit,
  );
  const timeline = timelineCandidates.slice(0, timelineLimit);
  const timelineAtReaderCap = timelineLimit === 50 && timelineCandidates.length === 50;
  const timelineHasMore = timelineAtReaderCap ? null : timelineCandidates.length > timelineLimit;
  const failure =
    activity.outcome === 'failure' ? await getFailureAttemptById(ctx.db, activity.event_id) : null;
  const cause = failure ? effectiveCauseForFailureAttempt(failure) : null;
  const records = await listLearningRecords(ctx.db, {
    attempt_event_id: activity.event_id,
    limit: 25,
  });

  return OutputSchema.parse({
    lookup: {
      requested_event_id: input.attemptEventId,
      status: 'found',
      observed,
    },
    attempt: activity,
    question:
      questionAvailability === 'found' && questionRow
        ? {
            id: questionRow.id,
            kind: questionRow.kind,
            prompt_md: questionRow.prompt_md,
            reference_md: questionRow.reference_md ?? null,
            knowledge_ids: questionRow.knowledge_ids ?? [],
          }
        : null,
    question_availability: questionAvailability,
    cause: cause
      ? {
          source: cause.source,
          event_id: cause.event_id,
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
            dispatch_seq: entry.dispatch_seq,
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
            dispatch_seq: entry.dispatch_seq,
            created_at: entry.created_at.toISOString(),
            fsrs_rating: entry.fsrs_rating,
            outcome: entry.outcome,
            duration_ms: entry.duration_ms,
          },
    ),
    timeline_scope: 'same_question_context_noncausal',
    timeline_coverage: {
      returned_count: timeline.length,
      limit: timelineLimit,
      has_more: timelineHasMore,
      complete: timelineHasMore === null ? null : !timelineHasMore,
    },
    causal_neighborhood: causal,
    linked_records: records.map((record) => ({
      id: record.id,
      kind: record.kind,
      title: record.title ?? null,
      content_md: record.content_md,
      created_at: record.created_at.toISOString(),
    })),
  });
}

function summarize(input: Input, output: Output): string {
  const qid = output.attempt?.question_id ?? '(missing)';
  const action = output.attempt?.action ?? output.lookup.status;
  const cause = output.cause?.primary_category ?? 'no-cause';
  const more = output.causal_neighborhood.coverage.has_more ? ' · causal-more' : '';
  return `${action} ${input.attemptEventId.slice(0, 8)} · q=${qid.slice(0, 8)} · cause=${cause} · timeline=${output.timeline.length} · records=${output.linked_records.length}${more}`;
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
