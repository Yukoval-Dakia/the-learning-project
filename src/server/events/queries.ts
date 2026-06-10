// Phase 1c.1 Step 4 — events queries module (ADR-0005 single-owner read/write API).
//
// Per spec §"New module: src/server/events/queries.ts" (docs/superpowers/plans/
// 2026-05-16-phase1c1-step4-server-readpath.md): all event reads/writes go through
// this module. Other modules import named fns; raw `db.insert(event)` outside this
// module is forbidden.
//
// YUK-101 / ADR-0021 — `writeEvent` is INSERT-only (ADR-0005 single-owner
// invariant restored). Mem0 ingest is wired via the transactional outbox:
// `event.ingest_at IS NULL` marks pending rows; a separate poll handler in
// `src/server/memory/triggers.ts` picks them up with SELECT...FOR UPDATE
// SKIP LOCKED, enqueues `memory_event_ingest`, and stamps `ingest_at = now()`.
// Caller transactions that roll back leave zero `event` rows AND zero ingest
// jobs (vs the pre-outbox model where enqueue committed independently of the
// caller tx and produced orphan jobs).
//
// Read API:
//   - getFailureAttempts(db, opts?) — failure attempts + chained judge (mistake view)
//   - getJudgeForAttempt(db, attemptEventId) — single chained judge
//   - getRecentReviewEvents(db, opts?) — FSRS review log
//   - getEventById(db, id) — single event for caused_by chain navigation
//   - getEvents(db, filter?) — Step 6: raw event log filter API (parseEvent on output)
//   - getEventChain(db, id) — Step 6: focal event + parent + reverse children
//
// Write API:
//   - writeEvent(db, eventObj) — single INSERT path; calls parseEvent() before INSERT;
//     idempotent via PK conflict do-nothing.

import {
  type EffectiveTruth,
  activeEffectiveTruth,
  getEffectiveTruths,
} from '@/capabilities/practice/server/effective-truth';
import { type EventT, parseEvent } from '@/core/schema/event';
import type { CauseCategoryT, CauseSchemaT, FsrsStateSchemaT } from '@/core/schema/event/blocks';
import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';
import { computeAffectedScopes } from '@/server/memory/scope_tagger';
import { and, desc, eq, gte, inArray, ne, sql } from 'drizzle-orm';
import {
  type CorrectionStatus,
  activeCorrectionStatus,
  getCorrectionStatuses,
} from './corrections';

type DbLike = Db | Tx;
type EventRow = typeof event.$inferSelect;

function hasActiveCorrectionStatus(status: CorrectionStatus | undefined): boolean {
  return status?.state === 'active';
}

// ============================================================================
// FailureAttempt — user-facing "mistake" view projected from the event stream.
// One row per attempt event with outcome='failure'; optional joined judge event
// chained via caused_by_event_id reverse lookup.
// ============================================================================

export type FailureAttemptJudge = {
  judge_event_id: string;
  cause: CauseSchemaT;
  referenced_knowledge_ids: string[];
  created_at: Date;
  correction_state: EffectiveTruth;
};

// User-supplied cause via experimental:user_cause event (Phase 1c.2). Lives
// alongside `judge` because both can coexist on the same attempt — projection
// callers pick user_cause first (the user has the last word on attribution).
export type FailureAttemptUserCause = {
  user_cause_event_id: string;
  primary_category: CauseCategoryT;
  user_notes: string | null;
  created_at: Date;
  correction_state: EffectiveTruth;
};

export type FailureAttempt = {
  attempt_event_id: string;
  question_id: string;
  answer_md: string | null;
  answer_image_refs: string[];
  referenced_knowledge_ids: string[];
  created_at: Date;
  correction_state: EffectiveTruth;
  judge?: FailureAttemptJudge;
  user_cause?: FailureAttemptUserCause;
};

export interface GetFailureAttemptsOpts {
  limit?: number | null;
  questionIds?: string[];
  since?: Date;
  // YUK-76 codex round-3 P1 — per-question SQL partition cap.
  //
  // When set, SQL filters via `ROW_NUMBER() OVER (PARTITION BY subject_id …)`
  // so each question contributes at most `perQuestionLimit * 3` rows to the
  // active-correction pre-filter (×3 mirrors the ×3 buffer the global-`limit`
  // path uses for active-row overhead). The final per-question cap is then
  // applied in JS after the active-correction filter so each question returns
  // ≤ `perQuestionLimit` active failures.
  //
  // Mutually exclusive with `limit`: callers using per-question coverage
  // semantics (e.g. `/api/review/due` building the never-reviewed slice) want
  // each question represented, not a flat newest-first window. When provided,
  // the function ignores `limit` and skips the offset-based batch loop because
  // the partitioned slice is already bounded by `questionIds.length *
  // perQuestionLimit * 3`.
  perQuestionLimit?: number;
}

const DEFAULT_FAILURE_ATTEMPTS_LIMIT = 100;

async function rowsById(db: DbLike, ids: string[]): Promise<Map<string, EventRow>> {
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length === 0) return new Map();
  const rows = await db.select().from(event).where(inArray(event.id, uniqueIds));
  return new Map(rows.map((row) => [row.id, row]));
}

async function resolveEffectiveActiveRows(
  db: DbLike,
  rows: EventRow[],
): Promise<Map<string, { row: EventRow; truth: EffectiveTruth }>> {
  const truthByOriginal = await getEffectiveTruths(
    db,
    rows.map((row) => row.id),
  );
  const rowById = new Map(rows.map((row) => [row.id, row]));
  const missingEffectiveIds = [...truthByOriginal.values()]
    .map((truth) => truth.effective_event_id)
    .filter((id): id is string => typeof id === 'string' && !rowById.has(id));
  for (const [id, row] of await rowsById(db, missingEffectiveIds)) {
    rowById.set(id, row);
  }

  const out = new Map<string, { row: EventRow; truth: EffectiveTruth }>();
  for (const original of rows) {
    const truth = truthByOriginal.get(original.id) ?? activeEffectiveTruth(original.id);
    if (truth.terminal_state !== 'active' || !truth.effective_event_id) continue;
    const effectiveRow = rowById.get(truth.effective_event_id);
    if (!effectiveRow) continue;
    if (effectiveRow.action !== original.action) continue;
    if (effectiveRow.subject_kind !== original.subject_kind) continue;
    if (effectiveRow.subject_id !== original.subject_id) continue;
    out.set(original.id, { row: effectiveRow, truth });
  }
  return out;
}

function newerEventRow(a: EventRow, b: EventRow): boolean {
  return (
    a.created_at > b.created_at ||
    (a.created_at.getTime() === b.created_at.getTime() && a.id > b.id)
  );
}

/**
 * Returns failure attempts (with chained judges populated when present), ordered
 * by created_at desc. Default limit 100 matches legacy RECENT_MISTAKES_LIMIT.
 *
 * Two queries + JS join (vs single subquery): clearer code, well-bounded by limit.
 * Judge lookup uses `event_caused_by_idx`. Filter must keep outcome='failure' —
 * the event stream stores successes too.
 */
export async function getFailureAttempts(
  db: DbLike,
  opts: GetFailureAttemptsOpts = {},
): Promise<FailureAttempt[]> {
  const unbounded = opts.limit === null;
  const limit = opts.limit ?? DEFAULT_FAILURE_ATTEMPTS_LIMIT;
  const perQuestionLimit = opts.perQuestionLimit;
  if (perQuestionLimit !== undefined && perQuestionLimit <= 0) return [];
  if (perQuestionLimit === undefined && !unbounded && limit <= 0) return [];
  const conditions = [
    eq(event.action, 'attempt'),
    eq(event.subject_kind, 'question'),
    eq(event.outcome, 'failure'),
  ];
  if (opts.questionIds && opts.questionIds.length > 0) {
    conditions.push(inArray(event.subject_id, opts.questionIds));
  }
  if (opts.since) {
    conditions.push(gte(event.created_at, opts.since));
  }
  // YUK-76 codex P2 — secondary `desc(event.id)` makes the order
  // deterministic when two failure attempts share the same `created_at`.
  // Without it, callers like `/api/review/due`'s per-question cap pick a
  // non-deterministic representative across requests.
  let activeAttemptRows: EventRow[];

  if (perQuestionLimit !== undefined) {
    // YUK-76 codex round-3 P1 — partition-by-question SQL slice so each
    // question gets its own bounded window, not a global newest-first feed.
    // `getFailureAttempts({ limit })` would let a hot question saturate the
    // global limit and silently drop quieter questions from the result. The
    // `* 3` buffer matches the global-`limit` path's pre-filter overhead for
    // active corrections (some head rows get retracted; over-sample so the
    // final per-question cap still holds). If a partition head is fully
    // retracted, keep fetching deeper windows for that question.
    const partitionBatchLimit = perQuestionLimit * 3;
    const activeRowsByQuestion = new Map<string, EventRow[]>();
    const targetQuestionIds =
      opts.questionIds && opts.questionIds.length > 0 ? [...new Set(opts.questionIds)] : null;
    let partitionOffset = 0;
    for (;;) {
      const attemptRows = await getPartitionedFailureRows(
        db,
        conditions,
        partitionOffset,
        partitionBatchLimit,
      );
      if (attemptRows.length === 0) break;
      const filtered = await filterActiveRows(db, attemptRows);
      for (const row of filtered) {
        const rows = activeRowsByQuestion.get(row.subject_id) ?? [];
        if (rows.length >= perQuestionLimit) continue;
        rows.push(row);
        activeRowsByQuestion.set(row.subject_id, rows);
      }
      if (
        targetQuestionIds?.every((questionId) => {
          const rows = activeRowsByQuestion.get(questionId);
          return rows !== undefined && rows.length >= perQuestionLimit;
        }) === true
      ) {
        break;
      }
      partitionOffset += partitionBatchLimit;
    }
    activeAttemptRows = [...activeRowsByQuestion.values()]
      .flat()
      .sort((a, b) => b.created_at.getTime() - a.created_at.getTime() || b.id.localeCompare(a.id));
  } else {
    const attemptQuery = db
      .select()
      .from(event)
      .where(and(...conditions))
      .orderBy(desc(event.created_at), desc(event.id));
    const attemptRows = unbounded ? await attemptQuery : await attemptQuery.limit(limit * 3);

    if (attemptRows.length === 0) return [];

    activeAttemptRows = unbounded
      ? await filterActiveRows(db, attemptRows)
      : await takeActiveRows(db, attemptRows, limit, async (nextLimit, offset) =>
          db
            .select()
            .from(event)
            .where(and(...conditions))
            .orderBy(desc(event.created_at), desc(event.id))
            .limit(nextLimit)
            .offset(offset),
        );
  }

  if (activeAttemptRows.length === 0) return [];

  const attemptIds = activeAttemptRows.map((r) => r.id);
  // One round-trip fetches BOTH judge events (action='judge') and user_cause
  // events (action='experimental:user_cause'). Both chain via caused_by_event_id
  // and have subject_kind='event'.
  const chainedRows = await db
    .select()
    .from(event)
    .where(
      and(
        eq(event.subject_kind, 'event'),
        inArray(event.caused_by_event_id, attemptIds),
        inArray(event.action, ['judge', 'experimental:user_cause']),
      ),
    );
  const effectiveChainedRows = await resolveEffectiveActiveRows(db, chainedRows);
  const attemptTruths = await getEffectiveTruths(db, attemptIds);

  // Group by (action, caused_by_event_id); keep newest within each group.
  const judgeByAttempt = new Map<string, { row: EventRow; truth: EffectiveTruth }>();
  const userCauseByAttempt = new Map<string, { row: EventRow; truth: EffectiveTruth }>();
  for (const originalRow of chainedRows) {
    const effective = effectiveChainedRows.get(originalRow.id);
    if (!effective) continue;
    const key = originalRow.caused_by_event_id as string;
    const bucket = effective.row.action === 'judge' ? judgeByAttempt : userCauseByAttempt;
    const existing = bucket.get(key);
    if (!existing || newerEventRow(effective.row, existing.row)) {
      bucket.set(key, effective);
    }
  }

  return activeAttemptRows.map((a) => {
    const payload = a.payload as {
      answer_md: string | null;
      answer_image_refs: string[];
      referenced_knowledge_ids: string[];
    };
    const result: FailureAttempt = {
      attempt_event_id: a.id,
      question_id: a.subject_id,
      answer_md: payload.answer_md ?? null,
      answer_image_refs: payload.answer_image_refs ?? [],
      referenced_knowledge_ids: payload.referenced_knowledge_ids ?? [],
      created_at: a.created_at,
      correction_state: attemptTruths.get(a.id) ?? activeEffectiveTruth(a.id),
    };
    const j = judgeByAttempt.get(a.id);
    if (j) {
      const jPayload = j.row.payload as {
        cause: CauseSchemaT;
        referenced_knowledge_ids: string[];
      };
      result.judge = {
        judge_event_id: j.row.id,
        cause: jPayload.cause,
        referenced_knowledge_ids: jPayload.referenced_knowledge_ids ?? [],
        created_at: j.row.created_at,
        correction_state: j.truth,
      };
    }
    const uc = userCauseByAttempt.get(a.id);
    if (uc) {
      const ucPayload = uc.row.payload as {
        primary_category: CauseCategoryT;
        user_notes?: string | null;
      };
      result.user_cause = {
        user_cause_event_id: uc.row.id,
        primary_category: ucPayload.primary_category,
        user_notes: ucPayload.user_notes ?? null,
        created_at: uc.row.created_at,
        correction_state: uc.truth,
      };
    }
    return result;
  });
}

/**
 * Returns the (latest) judge event chained to the given attempt, or null.
 * Uses `event_caused_by_idx`.
 */
export async function getJudgeForAttempt(
  db: DbLike,
  attemptEventId: string,
): Promise<FailureAttemptJudge | null> {
  const rows = await db
    .select()
    .from(event)
    .where(
      and(
        eq(event.action, 'judge'),
        eq(event.subject_kind, 'event'),
        eq(event.caused_by_event_id, attemptEventId),
      ),
    )
    .orderBy(desc(event.created_at), desc(event.id));
  const effectiveRows = await resolveEffectiveActiveRows(db, rows);
  const j = rows
    .map((row) => effectiveRows.get(row.id))
    .filter((row): row is { row: EventRow; truth: EffectiveTruth } => row !== undefined)
    .sort((a, b) => {
      if (newerEventRow(a.row, b.row)) return -1;
      if (newerEventRow(b.row, a.row)) return 1;
      return 0;
    })[0];
  if (!j) return null;
  const jPayload = j.row.payload as {
    cause: CauseSchemaT;
    referenced_knowledge_ids: string[];
  };
  return {
    judge_event_id: j.row.id,
    cause: jPayload.cause,
    referenced_knowledge_ids: jPayload.referenced_knowledge_ids ?? [],
    created_at: j.row.created_at,
    correction_state: j.truth,
  };
}

/**
 * Returns the (latest) user_cause event chained to the given attempt, or null.
 * Mirrors getJudgeForAttempt but for the experimental:user_cause channel
 * (Phase 1c.2). Uses `event_caused_by_idx`.
 */
export async function getUserCauseForAttempt(
  db: DbLike,
  attemptEventId: string,
): Promise<FailureAttemptUserCause | null> {
  const rows = await db
    .select()
    .from(event)
    .where(
      and(
        eq(event.action, 'experimental:user_cause'),
        eq(event.subject_kind, 'event'),
        eq(event.caused_by_event_id, attemptEventId),
      ),
    )
    .orderBy(desc(event.created_at), desc(event.id));
  const effectiveRows = await resolveEffectiveActiveRows(db, rows);
  const uc = rows
    .map((row) => effectiveRows.get(row.id))
    .filter((row): row is { row: EventRow; truth: EffectiveTruth } => row !== undefined)
    .sort((a, b) => {
      if (newerEventRow(a.row, b.row)) return -1;
      if (newerEventRow(b.row, a.row)) return 1;
      return 0;
    })[0];
  if (!uc) return null;
  const ucPayload = uc.row.payload as {
    primary_category: CauseCategoryT;
    user_notes?: string | null;
  };
  return {
    user_cause_event_id: uc.row.id,
    primary_category: ucPayload.primary_category,
    user_notes: ucPayload.user_notes ?? null,
    created_at: uc.row.created_at,
    correction_state: uc.truth,
  };
}

/**
 * Returns one active failure attempt projection by id, including active user
 * cause / judge channels. This is for queue consumers that already know the
 * attempt id and must not scan by question recency.
 */
export async function getFailureAttemptById(
  db: DbLike,
  attemptEventId: string,
): Promise<FailureAttempt | null> {
  const rows = await db.select().from(event).where(eq(event.id, attemptEventId)).limit(1);
  const attempt = rows[0];
  if (!attempt) return null;
  if (
    attempt.action !== 'attempt' ||
    attempt.subject_kind !== 'question' ||
    attempt.outcome !== 'failure'
  ) {
    return null;
  }

  const attemptTruth =
    (await getEffectiveTruths(db, [attempt.id])).get(attempt.id) ??
    activeEffectiveTruth(attempt.id);
  if (attemptTruth.terminal_state !== 'active' || attemptTruth.effective_event_id !== attempt.id) {
    return null;
  }

  const payload = attempt.payload as {
    answer_md: string | null;
    answer_image_refs: string[];
    referenced_knowledge_ids: string[];
  };
  const [judge, userCause] = await Promise.all([
    getJudgeForAttempt(db, attempt.id),
    getUserCauseForAttempt(db, attempt.id),
  ]);
  const failure: FailureAttempt = {
    attempt_event_id: attempt.id,
    question_id: attempt.subject_id,
    answer_md: payload.answer_md ?? null,
    answer_image_refs: payload.answer_image_refs ?? [],
    referenced_knowledge_ids: payload.referenced_knowledge_ids ?? [],
    created_at: attempt.created_at,
    correction_state: attemptTruth,
  };
  if (judge) failure.judge = judge;
  if (userCause) failure.user_cause = userCause;
  return failure;
}

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
      created_at: Date;
      outcome: 'success' | 'failure' | 'partial';
      duration_ms: number | null;
      cause: { primary: string; confidence: number | null } | null;
    }
  | {
      kind: 'review';
      event_id: string;
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
    .orderBy(desc(event.created_at))
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
        .orderBy(desc(event.created_at))
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

// ============================================================================
// getEventById — single event lookup (caused_by chain navigation).
// ============================================================================

// Internal row → parseEvent input projection. parseEvent only validates Lane B's
// user payload shape (action / subject / outcome / payload + base optional
// fields); the DB row's id / session_id / created_at envelope fields are stripped.
function rowToParseInput(row: typeof event.$inferSelect): Parameters<typeof parseEvent>[0] {
  return {
    actor_kind: row.actor_kind,
    actor_ref: row.actor_ref,
    action: row.action,
    subject_kind: row.subject_kind,
    subject_id: row.subject_id,
    outcome: row.outcome,
    payload: row.payload,
    caused_by_event_id: row.caused_by_event_id ?? undefined,
    task_run_id: row.task_run_id ?? undefined,
    cost_micro_usd: row.cost_micro_usd ?? undefined,
  };
}

/**
 * Fetches one event by id and returns the parsed KnownEvent shape (validated
 * via parseEvent — failures throw, never silently swallowed). Returns null
 * when the row is absent.
 */
export async function getEventById(db: DbLike, id: string): Promise<EnvelopedEvent | null> {
  const rows = await db.select().from(event).where(eq(event.id, id)).limit(1);
  const enveloped = await rowsToEnvelopedEvents(db, rows);
  return enveloped[0] ?? null;
}

// ============================================================================
// getEvents — Phase 1c.1 Step 6: raw event log filter API.
//
// Filters AND-combined. Default limit 50, max 200. Output goes through
// parseEvent — guards schema drift on the way OUT (Step 4's writeEvent only
// guards INWARD writes). A corrupted row throws (something tampered the db);
// callers must surface, not silently skip.
// ============================================================================

export interface GetEventsFilter {
  action?: string;
  subject_kind?: string;
  subject_id?: string;
  actor_kind?: string;
  actor_ref?: string;
  outcome?: string;
  since?: Date;
  limit?: number;
}

const DEFAULT_EVENTS_LIMIT = 50;
const MAX_EVENTS_LIMIT = 200;

// EventT plus the envelope fields callers need to identify the row (id) or
// order things along time (created_at). Phase 1c.2 added these because the
// /api/events consumers (notably the edge-proposal decide flow) need the
// event id to address proposals on the wire.
export type EnvelopedEvent = EventT & {
  id: string;
  created_at: Date;
  correction_status: CorrectionStatus;
};

async function rowsToEnvelopedEvents(db: DbLike, rows: EventRow[]): Promise<EnvelopedEvent[]> {
  const statuses = await getCorrectionStatuses(
    db,
    rows.map((r) => r.id),
  );
  return rows.map(
    (r) =>
      ({
        ...parseEvent(rowToParseInput(r)),
        id: r.id,
        created_at: r.created_at,
        correction_status: statuses.get(r.id) ?? activeCorrectionStatus(),
      }) as EnvelopedEvent,
  );
}

async function takeActiveRows(
  db: DbLike,
  firstRows: EventRow[],
  limit: number,
  fetchNextRows: (limit: number, offset: number) => Promise<EventRow[]>,
): Promise<EventRow[]> {
  const batchSize = Math.max(limit * 3, limit);
  const activeRows: EventRow[] = [];
  let rows = firstRows;
  let offset = firstRows.length;

  while (rows.length > 0) {
    const statuses = await getCorrectionStatuses(
      db,
      rows.map((r) => r.id),
    );
    for (const row of rows) {
      if (hasActiveCorrectionStatus(statuses.get(row.id))) {
        activeRows.push(row);
        if (activeRows.length >= limit) return activeRows;
      }
    }
    if (rows.length < batchSize) break;
    rows = await fetchNextRows(batchSize, offset);
    offset += rows.length;
  }

  return activeRows;
}

async function filterActiveRows(db: DbLike, rows: EventRow[]): Promise<EventRow[]> {
  if (rows.length === 0) return [];
  const statuses = await getCorrectionStatuses(
    db,
    rows.map((r) => r.id),
  );
  return rows.filter((row) => hasActiveCorrectionStatus(statuses.get(row.id)));
}

// YUK-76 codex round-3 P1 — per-question partition for failure-attempt scan.
//
// `getFailureAttempts({ perQuestionLimit })` needs each question to contribute
// at most `partitionLimit` rows (before active-correction filter), regardless
// of how dense any single question's history is. We run `ROW_NUMBER()
// PARTITION BY subject_id` and keep the partitioned slice; the caller applies
// the post-filter cap in JS so behaviour mirrors the legacy global-`limit`
// path (which over-samples by ×3 to absorb retraction overhead).
//
// We can't express `inArray` over a JS array cleanly inside a raw `sql` string
// from drizzle, so we cap subject_id via the same `inArray` builder by doing a
// CTE outer-select pattern. Easier: build the outer `SELECT *` in drizzle and
// use a raw lateral subquery for the rownumber filter.
async function getPartitionedFailureRows(
  db: DbLike,
  // biome-ignore lint/suspicious/noExplicitAny: drizzle condition tuple is heterogeneous.
  conditions: any[],
  partitionOffset: number,
  partitionLimit: number,
): Promise<EventRow[]> {
  // We re-use the existing drizzle condition tuple by wrapping the partitioned
  // CTE in a subquery and joining back to `event` on id. This keeps the
  // condition predicates (action / outcome / questionIds / since) in one place
  // and avoids re-implementing them in raw SQL.
  const ranked = db
    .select({
      id: event.id,
      rn: sql<number>`row_number() OVER (PARTITION BY ${event.subject_id} ORDER BY ${event.created_at} DESC, ${event.id} DESC)`.as(
        'rn',
      ),
    })
    .from(event)
    .where(and(...conditions))
    .as('ranked');

  const rows = await db
    .select({
      id: event.id,
      session_id: event.session_id,
      actor_kind: event.actor_kind,
      actor_ref: event.actor_ref,
      action: event.action,
      subject_kind: event.subject_kind,
      subject_id: event.subject_id,
      outcome: event.outcome,
      payload: event.payload,
      caused_by_event_id: event.caused_by_event_id,
      task_run_id: event.task_run_id,
      cost_micro_usd: event.cost_micro_usd,
      created_at: event.created_at,
    })
    .from(event)
    .innerJoin(ranked, eq(event.id, ranked.id))
    .where(
      sql`${ranked.rn} > ${partitionOffset} AND ${ranked.rn} <= ${partitionOffset + partitionLimit}`,
    )
    .orderBy(desc(event.created_at), desc(event.id));
  return rows as EventRow[];
}

export async function getEvents(
  db: DbLike,
  filter: GetEventsFilter = {},
): Promise<EnvelopedEvent[]> {
  const limit = Math.min(filter.limit ?? DEFAULT_EVENTS_LIMIT, MAX_EVENTS_LIMIT);
  const conditions = [];
  if (filter.action) conditions.push(eq(event.action, filter.action));
  if (filter.subject_kind) conditions.push(eq(event.subject_kind, filter.subject_kind));
  if (filter.subject_id) conditions.push(eq(event.subject_id, filter.subject_id));
  if (filter.actor_kind) conditions.push(eq(event.actor_kind, filter.actor_kind));
  if (filter.actor_ref) conditions.push(eq(event.actor_ref, filter.actor_ref));
  if (filter.outcome) conditions.push(eq(event.outcome, filter.outcome));
  if (filter.since) conditions.push(gte(event.created_at, filter.since));

  const baseQuery = db.select().from(event);
  const filtered = conditions.length > 0 ? baseQuery.where(and(...conditions)) : baseQuery;
  const rows = await filtered.orderBy(desc(event.created_at)).limit(limit);

  return rowsToEnvelopedEvents(db, rows);
}

// ============================================================================
// getEventChain — Phase 1c.1 Step 6: caused_by chain navigation.
//
// Returns the focal event's parent (caused_by_event_id resolved) + the events
// that point back to it via caused_by_event_id (reverse lookup, supported by
// `event_caused_by_idx`). Throws when focal event id is unknown — the caller
// asked for a specific id, so missing = error, not empty chain.
// ============================================================================

export type EventChain = {
  caused_by: EnvelopedEvent | null;
  caused_events: EnvelopedEvent[];
  corrections: EnvelopedEvent[];
};

export async function getEventChain(db: DbLike, id: string): Promise<EventChain> {
  const focal = await getEventById(db, id);
  if (focal === null) {
    throw new Error(`event ${id} not found`);
  }

  // Forward link: caused_by_event_id (envelope field; not on parsed EventT)
  const focalRows = await db
    .select({ caused_by_event_id: event.caused_by_event_id })
    .from(event)
    .where(eq(event.id, id))
    .limit(1);
  const caused_by_event_id = focalRows[0]?.caused_by_event_id ?? null;

  const caused_by = caused_by_event_id ? await getEventById(db, caused_by_event_id) : null;

  // Reverse link: events with caused_by_event_id = id. Use index on caused_by_event_id.
  const reverseRows = await db
    .select()
    .from(event)
    .where(and(eq(event.caused_by_event_id, id), ne(event.action, 'correct')))
    .orderBy(desc(event.created_at));
  const caused_events = await rowsToEnvelopedEvents(db, reverseRows);

  const correctionRows = await db
    .select()
    .from(event)
    .where(
      and(eq(event.action, 'correct'), eq(event.subject_kind, 'event'), eq(event.subject_id, id)),
    )
    .orderBy(desc(event.created_at), desc(event.id));
  const corrections = await rowsToEnvelopedEvents(db, correctionRows);

  return { caused_by, caused_events, corrections };
}

// ============================================================================
// writeEvent — single-owner INSERT path (ADR-0005).
// ============================================================================

export interface WriteEventInput {
  id: string;
  session_id?: string | null;
  actor_kind: string;
  actor_ref: string;
  action: string;
  subject_kind: string;
  subject_id: string;
  outcome?: string | null;
  payload: unknown;
  caused_by_event_id?: string | null;
  affected_scopes?: string[];
  task_run_id?: string | null;
  cost_micro_usd?: number | null;
  created_at?: Date;
  /**
   * ADR-0021 opt-out: when set non-NULL at INSERT, the memory-ingestion outbox
   * poller (`src/server/memory/triggers.ts` — `WHERE ingest_at IS NULL`) skips
   * this event, so it never spawns a Mem0 `add` or brief-regen. Default NULL
   * preserves the pending-ingest semantics for every existing caller. Stamping
   * `ingest_at = now` is an *opt-out of memory ingestion*, NOT a claim that
   * ingestion already ran. Used by the observe-only auto-enroll trail (YUK-190).
   */
  ingest_at?: Date | null;
}

/**
 * The single INSERT path for `event` rows. parseEvent() validates the row
 * matches a KnownEvent or experimental:* shape before writing — failures throw,
 * never silently swallowed. Per ADR-0005, no other module should call
 * `db.insert(event)` directly.
 *
 * Idempotency: PK conflict do-nothing means re-running with the same id is
 * safe. When a conflict happens we fetch the existing row's id (which equals
 * the caller's id) so callers don't need to special-case the "did nothing" path.
 * First write wins — second write does NOT overwrite payload.
 */
export async function writeEvent(db: DbLike, input: WriteEventInput): Promise<string> {
  // parseEvent on a normalised view — Lane B's discriminated union locks
  // action/subject/outcome/payload. Envelope fields (id, session_id, created_at,
  // etc.) live on the DB row but outside Lane B's contract, so they're not
  // included in the parse input.
  parseEvent({
    actor_kind: input.actor_kind,
    actor_ref: input.actor_ref,
    action: input.action,
    subject_kind: input.subject_kind,
    subject_id: input.subject_id,
    outcome: input.outcome,
    payload: input.payload,
    caused_by_event_id: input.caused_by_event_id ?? undefined,
    task_run_id: input.task_run_id ?? undefined,
    cost_micro_usd: input.cost_micro_usd ?? undefined,
  });

  const affectedScopes = input.affected_scopes ?? computeAffectedScopes(input);

  await db
    .insert(event)
    .values({
      id: input.id,
      session_id: input.session_id ?? null,
      actor_kind: input.actor_kind,
      actor_ref: input.actor_ref,
      action: input.action,
      subject_kind: input.subject_kind,
      subject_id: input.subject_id,
      outcome: input.outcome ?? null,
      payload: input.payload as Record<string, unknown>,
      caused_by_event_id: input.caused_by_event_id ?? null,
      affected_scopes: affectedScopes,
      task_run_id: input.task_run_id ?? null,
      cost_micro_usd: input.cost_micro_usd ?? null,
      // NULL default = pending ingest (ADR-0021). A non-NULL stamp opts the row
      // out of the memory outbox poller (see WriteEventInput.ingest_at).
      ingest_at: input.ingest_at ?? null,
      created_at: input.created_at ?? new Date(),
    })
    .onConflictDoNothing({ target: event.id });

  // ADR-0021 — INSERT-only. The new row's `ingest_at` is NULL (pending). The
  // outbox poll handler in `src/server/memory/triggers.ts` picks it up and
  // enqueues `memory_event_ingest`. If `db` is a transaction that later rolls
  // back, the row is gone and nothing was enqueued — no orphan jobs.
  //
  // Drizzle's onConflictDoNothing returns an empty result on no-op. The caller's
  // id IS the row's id (deterministic or assigned), so return it directly.
  // First write wins — semantics documented at fn-doc.
  return input.id;
}
