// Domain event read models for review history and question timelines. Generic
// envelope storage lives in @/kernel/events.

import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import type { z } from 'zod';
import type { FsrsRating } from '@/core/schema/business';
import type { FsrsStateSchemaT } from '@/core/schema/event/blocks';
import type { Db, Tx } from '@/db/client';
import { event, question } from '@/db/schema';
import { filterActiveRows, takeActiveRows } from '@/kernel/events';
import { loadNativeReviewOccurrences } from '@/kernel/read-models/assessment-review-occurrences';
import {
  nativeAttemptOutcome,
  resolveVerdictsForAttempts,
  resolveVerdictsForNativeAttempts,
} from '@/kernel/read-models/assessment-verdict';
import { miscCauseLabelMap, resolveMiscCauseLabels } from '@/kernel/read-models/misc-cause-labels';
import { recordedDurationMs } from '@/kernel/read-models/review-timing';

type DbLike = Db | Tx;
type FsrsRatingT = z.infer<typeof FsrsRating>;

// ============================================================================
// ReviewEvent — FSRS review log view.
// ============================================================================

export type ReviewEvent = {
  review_event_id: string;
  question_id: string;
  fsrs_rating: FsrsRatingT;
  /** Absent on a native settlement receipt; the rating and outcome are the review. */
  fsrs_state_after: FsrsStateSchemaT | null;
  user_response_md: string | null;
  referenced_knowledge_ids: string[];
  outcome: 'success' | 'failure' | 'partial';
  created_at: Date;
};

export interface GetRecentReviewEventsOpts {
  limit?: number;
  questionIds?: string[];
  since?: Date;
}

const DEFAULT_REVIEW_EVENTS_LIMIT = 100;

/**
 * Settled native reviews, newest first. One row per question on the occurrence.
 * Filters by questionIds / since when provided.
 */
export async function getRecentReviewEvents(
  db: DbLike,
  opts: GetRecentReviewEventsOpts = {},
): Promise<ReviewEvent[]> {
  const limit = opts.limit ?? DEFAULT_REVIEW_EVENTS_LIMIT;
  if (limit <= 0) return [];
  const questionFilter =
    opts.questionIds && opts.questionIds.length > 0 ? new Set(opts.questionIds) : null;
  const occurrences = await loadNativeReviewOccurrences(db);
  const events: ReviewEvent[] = [];
  for (const occurrence of occurrences) {
    if (opts.since && occurrence.occurredAt < opts.since) continue;
    if (
      occurrence.outcome !== 'success' &&
      occurrence.outcome !== 'failure' &&
      occurrence.outcome !== 'partial'
    )
      continue;
    const seen = new Set<string>();
    for (const questionId of occurrence.questionIds) {
      if (seen.has(questionId) || (questionFilter && !questionFilter.has(questionId))) continue;
      seen.add(questionId);
      events.push({
        review_event_id: occurrence.settlementId,
        question_id: questionId,
        fsrs_rating: occurrence.rating,
        fsrs_state_after: null,
        user_response_md: null,
        referenced_knowledge_ids: [],
        outcome: occurrence.outcome,
        created_at: occurrence.occurredAt,
      });
    }
  }
  events.sort(
    (a, b) =>
      b.created_at.getTime() - a.created_at.getTime() ||
      b.review_event_id.localeCompare(a.review_event_id) ||
      a.question_id.localeCompare(b.question_id),
  );
  return events.slice(0, limit);
}

// ============================================================================
// getQuestionTimeline — per-question attempt + review history, newest first.
//
// Chained judge cause is hydrated onto attempt entries. Inactive (retracted or
// superseded) rows are filtered out. Limit defaults to 10, capped at 50.
// `actions` keeps one kind from filling the window of another: the latest
// score is an attempt read, and later reviews must not evict it.
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
      fsrs_rating: FsrsRatingT;
      outcome: 'success' | 'failure';
      duration_ms: number | null;
    };

const DEFAULT_QUESTION_TIMELINE_LIMIT = 10;
const MAX_QUESTION_TIMELINE_LIMIT = 50;

const QUESTION_TIMELINE_ACTIONS = ['attempt', 'review', 'experimental:assessment_attempt'] as const;
type QuestionTimelineAction = (typeof QUESTION_TIMELINE_ACTIONS)[number];

export async function getQuestionTimeline(
  db: DbLike,
  questionId: string,
  limit: number = DEFAULT_QUESTION_TIMELINE_LIMIT,
  actions: readonly QuestionTimelineAction[] = QUESTION_TIMELINE_ACTIONS,
): Promise<QuestionTimelineEntry[]> {
  if (actions.length === 0) return [];
  const effectiveLimit = Math.min(Math.max(limit, 1), MAX_QUESTION_TIMELINE_LIMIT);

  const conditions = [
    eq(event.subject_kind, 'question'),
    eq(event.subject_id, questionId),
    inArray(event.action, [...actions]),
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
      fsrs_rating: FsrsRatingT;
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

const ATTEMPT_FACT_ACTIONS = ['attempt', 'experimental:assessment_attempt'] as const;
const HINT_TRAJECTORY_LIMIT = 20;

export type JudgedAttemptCounts = { success: number; partial: number; failure: number };

export type AttemptFact = {
  question_id: string;
  event_id: string;
  dispatch_seq: number;
  created_at: Date;
  outcome: 'success' | 'failure' | 'partial' | 'pending' | 'unsupported' | string;
  duration_ms: number | null;
  /** Null when the attempt did not record a usable hints_used. Absence is not zero. */
  hints_used: number | null;
  final_hint_level: number | null;
};

export type HintDependence = {
  points: Array<{
    event_id: string;
    at: string;
    outcome: string;
    hints_used: number;
    final_hint_level: number | null;
  }>;
  recorded_attempts: number;
  omitted_attempts: number;
  truncated: boolean;
};

export type PersonalHitRate = {
  rate: number;
  hits: number;
  judged_attempts: number;
};

function nonnegativeInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function recordedHints(
  payload: unknown,
): { hints_used: number; final_hint_level: number | null } | null {
  if (!payload || typeof payload !== 'object' || !Object.hasOwn(payload, 'hints_used')) return null;
  const record = payload as Record<string, unknown>;
  const hintsUsed = nonnegativeInt(record.hints_used);
  if (hintsUsed === null) return null;
  const level = Object.hasOwn(record, 'final_hint_level')
    ? nonnegativeInt(record.final_hint_level)
    : null;
  return { hints_used: hintsUsed, final_hint_level: level };
}

function olderFirst(a: AttemptFact, b: AttemptFact): number {
  const at = a.created_at.getTime() - b.created_at.getTime();
  if (at !== 0) return at;
  if (a.dispatch_seq !== b.dispatch_seq) return a.dispatch_seq - b.dispatch_seq;
  if (a.event_id < b.event_id) return -1;
  if (a.event_id > b.event_id) return 1;
  return 0;
}

export function judgedAttemptCounts(rows: readonly AttemptFact[]): JudgedAttemptCounts {
  const counts = { success: 0, partial: 0, failure: 0 };
  for (const row of rows) {
    if (row.outcome === 'success') counts.success += 1;
    else if (row.outcome === 'partial') counts.partial += 1;
    else if (row.outcome === 'failure') counts.failure += 1;
  }
  return counts;
}

/** Successes over judged attempts. Partial is judged and is not a hit. No judged attempt is no rate. */
export function personalHitRate(counts: JudgedAttemptCounts): PersonalHitRate | null {
  const judged = counts.success + counts.partial + counts.failure;
  if (judged === 0) return null;
  return { rate: counts.success / judged, hits: counts.success, judged_attempts: judged };
}

export function medianOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid];
  if (upper === undefined) return null;
  if (sorted.length % 2 === 1) return upper;
  const lower = sorted[mid - 1];
  if (lower === undefined) return null;
  return (lower + upper) / 2;
}

export function recordedDurations(rows: readonly AttemptFact[]): number[] {
  return rows.flatMap((row) => (row.duration_ms === null ? [] : [row.duration_ms]));
}

/** Chronological hints_used points. Attempts with no usable hints_used stay in omitted_attempts. */
export function hintDependenceOf(rows: readonly AttemptFact[]): HintDependence | null {
  if (rows.length === 0) return null;
  const recorded = rows.flatMap((row) =>
    row.hints_used === null ? [] : [{ ...row, hints_used: row.hints_used }],
  );
  const ordered = [...recorded].sort(olderFirst);
  const truncated = ordered.length > HINT_TRAJECTORY_LIMIT;
  const window = truncated ? ordered.slice(-HINT_TRAJECTORY_LIMIT) : ordered;
  return {
    points: window.map((row) => ({
      event_id: row.event_id,
      at: row.created_at.toISOString(),
      outcome: row.outcome,
      hints_used: row.hints_used,
      final_hint_level: row.final_hint_level,
    })),
    recorded_attempts: recorded.length,
    omitted_attempts: rows.length - recorded.length,
    truncated,
  };
}

export async function readAttemptFacts(
  db: DbLike,
  questionIds: readonly string[],
): Promise<Map<string, AttemptFact[]>> {
  const ids = [...new Set(questionIds.filter((id) => id.length > 0))];
  const byQuestion = new Map<string, AttemptFact[]>();
  if (ids.length === 0) return byQuestion;
  const attemptRows = await db
    .select()
    .from(event)
    .where(
      and(
        eq(event.subject_kind, 'question'),
        inArray(event.subject_id, ids),
        inArray(event.action, [...ATTEMPT_FACT_ACTIONS]),
      ),
    );
  if (attemptRows.length === 0) return byQuestion;
  const activeRows = await filterActiveRows(db, attemptRows);
  const nativeVerdicts = await resolveVerdictsForNativeAttempts(db, activeRows);
  for (const row of activeRows) {
    const outcome =
      row.action === 'experimental:assessment_attempt'
        ? nativeAttemptOutcome(nativeVerdicts.get(row.id))
        : (row.outcome ?? 'unjudged');
    const hints = recordedHints(row.payload);
    const fact: AttemptFact = {
      question_id: row.subject_id,
      event_id: row.id,
      dispatch_seq: row.dispatch_seq,
      created_at: row.created_at,
      outcome,
      duration_ms: recordedDurationMs(row.payload),
      hints_used: hints?.hints_used ?? null,
      final_hint_level: hints?.final_hint_level ?? null,
    };
    const list = byQuestion.get(row.subject_id);
    if (list) list.push(fact);
    else byQuestion.set(row.subject_id, [fact]);
  }
  return byQuestion;
}

/** Recorded attempt durations on other questions with the same difficulty ordinal. */
export async function readSameDifficultyDurations(
  db: DbLike,
  difficulty: number,
  excludeQuestionId: string,
): Promise<number[]> {
  const peers = await db
    .select({ id: question.id })
    .from(question)
    .where(and(eq(question.difficulty, difficulty), ne(question.id, excludeQuestionId)));
  const facts = await readAttemptFacts(
    db,
    peers.map((row) => row.id),
  );
  return [...facts.values()].flatMap((rows) => recordedDurations(rows));
}

export async function getQuestionAttemptOutcomeCounts(
  db: DbLike,
  questionId: string,
): Promise<JudgedAttemptCounts> {
  const facts = await readAttemptFacts(db, [questionId]);
  return judgedAttemptCounts(facts.get(questionId) ?? []);
}

/** Current active attempts establish that a question was seen; no model inference. */
export async function getAttemptedQuestionIds(db: DbLike): Promise<string[]> {
  const rows = await db
    .select()
    .from(event)
    .where(
      and(
        eq(event.subject_kind, 'question'),
        inArray(event.action, ['attempt', 'review', 'experimental:assessment_attempt']),
      ),
    );
  return [...new Set((await filterActiveRows(db, rows)).map((row) => row.subject_id))];
}
