// Domain event read models. The knowledge-owned failure-attempt family moved to
// src/capabilities/knowledge/server/events/failure-attempts.ts (YUK-876); the
// question/FSRS-facing projections remain here until their owning lanes migrate
// them. The shared correction-status active-row helpers are exported for that
// capability-owned read port.
//
// Generic envelope storage lives in @/kernel/events.

import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import type { CauseSchemaT, FsrsStateSchemaT } from '@/core/schema/event/blocks';
import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';
import { filterActiveRows, newerEventRow, takeActiveRows } from '@/kernel/events';

type DbLike = Db | Tx;
type EventRow = typeof event.$inferSelect;
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
// getQuestionTimeline — YUK-58: per-question attempt + review history.
//
// Aggregates `event(action IN ('attempt','review'), subject_kind='question',
// subject_id=$1)` ordered desc by created_at, with chained judge cause
// (action='judge', subject_kind='event') hydrated onto attempt entries.
//
// Filters out retracted / superseded events via takeActiveRows. Limit defaults
// to 10, hard cap at MAX_QUESTION_TIMELINE_LIMIT (50). Powered by existing
// `event_subject_idx` and `event_caused_by_idx` — no new indexes.
// ============================================================================

export type QuestionTimelineEntry =
  | {
      kind: 'attempt';
      event_id: string;
      dispatch_seq: number;
      created_at: Date;
      outcome: 'success' | 'failure' | 'partial';
      duration_ms: number | null;
      cause: { primary: string; confidence: number | null } | null;
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
    inArray(event.action, ['attempt', 'review']),
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

  // Pull chained judge events for attempts in this slice (one round-trip).
  const attemptIds = activeRows.filter((r) => r.action === 'attempt').map((r) => r.id);
  const judgeByAttempt = new Map<string, EventRow>();
  if (attemptIds.length > 0) {
    const judgeRows = await db
      .select()
      .from(event)
      .where(
        and(
          eq(event.subject_kind, 'event'),
          eq(event.action, 'judge'),
          inArray(event.caused_by_event_id, attemptIds),
        ),
      );
    const activeJudgeRows = await filterActiveRows(db, judgeRows);
    // Keep newest judge per attempt.
    for (const row of activeJudgeRows) {
      const key = row.caused_by_event_id as string;
      const existing = judgeByAttempt.get(key);
      if (!existing || newerEventRow(row, existing)) judgeByAttempt.set(key, row);
    }
  }

  return activeRows.map((row): QuestionTimelineEntry => {
    if (row.action === 'attempt') {
      const payload = row.payload as {
        answer_md: string | null;
        answer_image_refs: string[];
        duration_ms?: number;
        referenced_knowledge_ids: string[];
      };
      const judge = judgeByAttempt.get(row.id);
      let cause: { primary: string; confidence: number | null } | null = null;
      if (judge) {
        const jPayload = judge.payload as { cause: CauseSchemaT };
        cause = {
          primary: jPayload.cause.primary_category,
          confidence: jPayload.cause.confidence ?? null,
        };
      }
      return {
        kind: 'attempt',
        event_id: row.id,
        dispatch_seq: row.dispatch_seq,
        created_at: row.created_at,
        outcome: (row.outcome as 'success' | 'failure' | 'partial') ?? 'failure',
        duration_ms: payload.duration_ms ?? null,
        cause,
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
// getQuestionAttemptOutcomeCounts — P5.6 / YUK-178 (§4.3): CUMULATIVE per-outcome
// attempt totals over a question's WHOLE lifetime (the corrective-chip trigger).
//
// NOT `getQuestionTimeline`: that reader is windowed (≤50), so once a question
// has >limit attempts the earliest failures drop out and the failure total can
// DECREASE — flapping the corrective chip back to proactive. This scans every
// `attempt` event and drops retracted/superseded rows via `filterActiveRows`,
// mirroring the `unbounded` branch of getFailureAttempts.
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
        eq(event.action, 'attempt'),
      ),
    )
    .orderBy(desc(event.created_at), desc(event.id));

  if (attemptRows.length === 0) return counts;

  const activeRows = await filterActiveRows(db, attemptRows);
  for (const row of activeRows) {
    if (row.outcome === 'success') counts.success += 1;
    else if (row.outcome === 'partial') counts.partial += 1;
    else counts.failure += 1;
  }
  return counts;
}
