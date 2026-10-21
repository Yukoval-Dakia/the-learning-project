// Domain event read models for review history and question timelines. Generic
// envelope storage lives in @/kernel/events.

import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import type { FsrsStateSchemaT } from '@/core/schema/event/blocks';
import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';
import { filterActiveRows, takeActiveRows } from '@/kernel/events';
import {
  nativeAttemptOutcome,
  resolveVerdictsForAttempts,
  resolveVerdictsForNativeAttempts,
} from '@/kernel/read-models/assessment-verdict';
import { miscCauseLabelMap, resolveMiscCauseLabels } from '@/kernel/read-models/misc-cause-labels';

type DbLike = Db | Tx;
// ============================================================================
// ReviewEvent — FSRS review log view.
// ============================================================================

export type ReviewEvent = {
  review_event_id: string;
  question_id: string;
  fsrs_rating: 'again' | 'hard' | 'good';
  fsrs_state_after: FsrsStateSchemaT;
  user_response_md: string | null;
  referenced_knowledge_ids: string[];
  outcome: 'success' | 'failure';
  created_at: Date;
};

export interface GetRecentReviewEventsOpts {
  limit?: number;
  questionIds?: string[];
  since?: Date;
}

const DEFAULT_REVIEW_EVENTS_LIMIT = 100;

/**
 * Returns review events ordered desc by created_at. Filters by questionIds /
 * since when provided. action='review' AND subject_kind='question' only — review
 * action on other materials may come in future phases.
 */
export async function getRecentReviewEvents(
  db: DbLike,
  opts: GetRecentReviewEventsOpts = {},
): Promise<ReviewEvent[]> {
  const limit = opts.limit ?? DEFAULT_REVIEW_EVENTS_LIMIT;
  if (limit <= 0) return [];
  const conditions = [eq(event.action, 'review'), eq(event.subject_kind, 'question')];
  if (opts.questionIds && opts.questionIds.length > 0) {
    conditions.push(inArray(event.subject_id, opts.questionIds));
  }
  if (opts.since) {
    conditions.push(gte(event.created_at, opts.since));
  }
  const rows = await db
    .select()
    .from(event)
    .where(and(...conditions))
    .orderBy(desc(event.created_at))
    .limit(limit * 3);

  const activeRows = await takeActiveRows(db, rows, limit, async (nextLimit, offset) =>
    db
      .select()
      .from(event)
      .where(and(...conditions))
      .orderBy(desc(event.created_at))
      .limit(nextLimit)
      .offset(offset),
  );

  return activeRows.map((r) => {
    const payload = r.payload as {
      fsrs_rating: 'again' | 'hard' | 'good';
      fsrs_state_after: FsrsStateSchemaT;
      user_response_md: string | null;
      referenced_knowledge_ids: string[];
    };
    return {
      review_event_id: r.id,
      question_id: r.subject_id,
      fsrs_rating: payload.fsrs_rating,
      fsrs_state_after: payload.fsrs_state_after,
      user_response_md: payload.user_response_md ?? null,
      referenced_knowledge_ids: payload.referenced_knowledge_ids ?? [],
      // review outcome invariant: again→failure, hard/good→success
      outcome: (r.outcome as 'success' | 'failure') ?? 'success',
      created_at: r.created_at,
    };
  });
}

// ============================================================================
// getQuestionTimeline — per-question attempt + review history, newest first.
//
// Chained judge cause is hydrated onto attempt entries. Inactive (retracted or
// superseded) rows are filtered out. Limit defaults to 10, capped at 50.
// ============================================================================

export type QuestionTimelineEntry =
  | {
      kind: 'attempt';
      event_id: string;
      dispatch_seq: number;
      created_at: Date;
      outcome: 'success' | 'failure' | 'partial' | 'pending' | 'unsupported';
      assessment?: {
        evaluation_group_id: string;
        original_evaluation_id: string | null;
        effective_evaluation_id: string | null;
      };
      duration_ms: number | null;
      cause: {
        primary: string;
        confidence: number | null;
        /** Display label for misc_ cause ids; vocabulary ids keep their raw id. */
        primary_label: string | null;
        /** Secondary cause ids as stored; the id is the identity. */
        secondary: string[];
        /** Display labels for resolvable misc_ secondary ids; callers fall back to the raw id. */
        secondary_labels: Record<string, string>;
      } | null;
      /**
       * Original vs effective judge ids. cause reads the effective verdict; null
       * when there is no judge.
       */
      judge: {
        original_event_id: string;
        effective_event_id: string | null;
      } | null;
    }
  | {
      kind: 'review';
      event_id: string;
      dispatch_seq: number;
      created_at: Date;
      fsrs_rating: 'again' | 'hard' | 'good';
      outcome: 'success' | 'failure';
      duration_ms: number | null;
    };

const DEFAULT_QUESTION_TIMELINE_LIMIT = 10;
const MAX_QUESTION_TIMELINE_LIMIT = 50;

export async function getQuestionTimeline(
  db: DbLike,
  questionId: string,
  limit: number = DEFAULT_QUESTION_TIMELINE_LIMIT,
): Promise<QuestionTimelineEntry[]> {
  const effectiveLimit = Math.min(Math.max(limit, 1), MAX_QUESTION_TIMELINE_LIMIT);

  const conditions = [
    eq(event.subject_kind, 'question'),
    eq(event.subject_id, questionId),
    inArray(event.action, ['attempt', 'review', 'experimental:assessment_attempt']),
  ];

  const firstRows = await db
    .select()
    .from(event)
    .where(and(...conditions))
    .orderBy(desc(event.created_at), desc(event.dispatch_seq), desc(event.id))
    .limit(effectiveLimit * 3);

  if (firstRows.length === 0) return [];

  const activeRows = await takeActiveRows(
    db,
    firstRows,
    effectiveLimit,
    async (nextLimit, offset) =>
      db
        .select()
        .from(event)
        .where(and(...conditions))
        .orderBy(desc(event.created_at), desc(event.dispatch_seq), desc(event.id))
        .limit(nextLimit)
        .offset(offset),
  );

  if (activeRows.length === 0) return [];

  // Resolve judges through both subject_id and caused_by: appeal re-judgments only
  // appear via the latter. cause reads the effective verdict.
  const attemptIds = activeRows
    .filter((r) => r.action === 'attempt' || r.action === 'experimental:assessment_attempt')
    .map((r) => r.id);
  const verdicts =
    attemptIds.length > 0 ? await resolveVerdictsForAttempts(db, attemptIds) : new Map();

  const nativeVerdicts = await resolveVerdictsForNativeAttempts(db, activeRows);

  // Resolve misc labels in one batch.
  const miscLabels = await resolveMiscCauseLabels(
    db,
    [...verdicts.values()].flatMap((v) => {
      const cause = v.effective?.verdict.cause;
      return cause ? [cause.primary_category, ...(cause.secondary_categories ?? [])] : [];
    }),
  );

  return activeRows.map((row): QuestionTimelineEntry => {
    const verdict = verdicts.get(row.id);
    const judgeCause = verdict?.effective?.verdict.cause ?? null;
    let cause: {
      primary: string;
      confidence: number | null;
      primary_label: string | null;
      secondary: string[];
      secondary_labels: Record<string, string>;
    } | null = null;
    if (judgeCause) {
      const secondary = judgeCause.secondary_categories ?? [];
      cause = {
        primary: judgeCause.primary_category,
        confidence: judgeCause.confidence ?? null,
        primary_label: miscLabels.get(judgeCause.primary_category) ?? null,
        secondary,
        secondary_labels: miscCauseLabelMap(miscLabels, secondary),
      };
    }

    if (row.action === 'experimental:assessment_attempt') {
      const group = nativeVerdicts.get(row.id);
      return {
        kind: 'attempt',
        event_id: row.id,
        dispatch_seq: row.dispatch_seq,
        created_at: row.created_at,
        outcome: nativeAttemptOutcome(group),
        duration_ms: typeof row.payload.duration_ms === 'number' ? row.payload.duration_ms : null,
        cause,
        judge:
          verdict?.original || verdict?.effective
            ? {
                original_event_id:
                  verdict.original?.judge_event_id ?? verdict.effective?.judge_event_id ?? '',
                effective_event_id: verdict.effective?.judge_event_id ?? null,
              }
            : null,
        ...(group
          ? {
              assessment: {
                evaluation_group_id: group.evaluation_group_id,
                original_evaluation_id: group.original_evaluation_id,
                effective_evaluation_id: group.effective?.evaluation_id ?? null,
              },
            }
          : {}),
      };
    }
    if (row.action === 'attempt') {
      const payload = row.payload as {
        answer_md: string | null;
        answer_image_refs: string[];
        duration_ms?: number;
        referenced_knowledge_ids: string[];
      };
      return {
        kind: 'attempt',
        event_id: row.id,
        dispatch_seq: row.dispatch_seq,
        created_at: row.created_at,
        outcome: (row.outcome as 'success' | 'failure' | 'partial') ?? 'failure',
        duration_ms: payload.duration_ms ?? null,
        cause,
        judge:
          verdict?.original || verdict?.effective
            ? {
                original_event_id:
                  verdict.original?.judge_event_id ?? verdict.effective?.judge_event_id ?? '',
                effective_event_id: verdict.effective?.judge_event_id ?? null,
              }
            : null,
      };
    }
    // review
    const payload = row.payload as {
      fsrs_rating: 'again' | 'hard' | 'good';
      duration_ms?: number;
    };
    return {
      kind: 'review',
      event_id: row.id,
      dispatch_seq: row.dispatch_seq,
      created_at: row.created_at,
      fsrs_rating: payload.fsrs_rating,
      outcome: (row.outcome as 'success' | 'failure') ?? 'success',
      duration_ms: payload.duration_ms ?? null,
    };
  });
}

// ============================================================================
// getQuestionAttemptOutcomeCounts — cumulative per-outcome totals over the
// question's whole lifetime.
//
// A windowed timeline could drop the earliest failures and make the corrective
// chip flap back to proactive. Scans every attempt and drops inactive rows.
// ============================================================================

export async function getQuestionAttemptOutcomeCounts(
  db: DbLike,
  questionId: string,
): Promise<{ success: number; partial: number; failure: number }> {
  const counts = { success: 0, partial: 0, failure: 0 };
  const attemptRows = await db
    .select()
    .from(event)
    .where(
      and(
        eq(event.subject_kind, 'question'),
        eq(event.subject_id, questionId),
        inArray(event.action, ['attempt', 'experimental:assessment_attempt']),
      ),
    )
    .orderBy(desc(event.created_at), desc(event.id));

  if (attemptRows.length === 0) return counts;

  const activeRows = await filterActiveRows(db, attemptRows);
  const nativeVerdicts = await resolveVerdictsForNativeAttempts(db, activeRows);
  for (const row of activeRows) {
    const outcome =
      row.action === 'experimental:assessment_attempt'
        ? nativeAttemptOutcome(nativeVerdicts.get(row.id))
        : row.outcome;
    if (outcome === 'success') counts.success += 1;
    else if (outcome === 'partial') counts.partial += 1;
    else if (outcome === 'failure') counts.failure += 1;
  }
  return counts;
}
