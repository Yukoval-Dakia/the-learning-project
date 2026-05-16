// Phase 1c.1 Step 4 — events queries module (ADR-0005 single-owner read/write API).
//
// Per spec §"New module: src/server/events/queries.ts" (docs/superpowers/plans/
// 2026-05-16-phase1c1-step4-server-readpath.md): all event reads/writes go through
// this module. Other modules import named fns; raw `db.insert(event)` outside this
// module is forbidden.
//
// Read API:
//   - getFailureAttempts(db, opts?) — failure attempts + chained judge (mistake view)
//   - getJudgeForAttempt(db, attemptEventId) — single chained judge
//   - getRecentReviewEvents(db, opts?) — FSRS review log
//   - getEventById(db, id) — single event for caused_by chain navigation
//
// Write API:
//   - writeEvent(db, eventObj) — single INSERT path; calls parseEvent() before INSERT;
//     idempotent via PK conflict do-nothing.

import { type EventT, parseEvent } from '@/core/schema/event';
import type { CauseSchemaT, FsrsStateSchemaT } from '@/core/schema/event/blocks';
import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';

type DbLike = Db | Tx;

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
};

export type FailureAttempt = {
  attempt_event_id: string;
  question_id: string;
  answer_md: string | null;
  answer_image_refs: string[];
  referenced_knowledge_ids: string[];
  created_at: Date;
  judge?: FailureAttemptJudge;
};

export interface GetFailureAttemptsOpts {
  limit?: number;
  questionIds?: string[];
  since?: Date;
}

const DEFAULT_FAILURE_ATTEMPTS_LIMIT = 100;

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
  const limit = opts.limit ?? DEFAULT_FAILURE_ATTEMPTS_LIMIT;
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
  const attemptRows = await db
    .select()
    .from(event)
    .where(and(...conditions))
    .orderBy(desc(event.created_at))
    .limit(limit);

  if (attemptRows.length === 0) return [];

  const attemptIds = attemptRows.map((r) => r.id);
  const judgeRows = await db
    .select()
    .from(event)
    .where(
      and(
        eq(event.action, 'judge'),
        eq(event.subject_kind, 'event'),
        inArray(event.caused_by_event_id, attemptIds),
      ),
    );

  // Group judges by caused_by_event_id (one judge per attempt expected; keep newest if dupes).
  const judgeByAttempt = new Map<string, (typeof judgeRows)[number]>();
  for (const j of judgeRows) {
    const key = j.caused_by_event_id as string;
    const existing = judgeByAttempt.get(key);
    if (!existing || j.created_at > existing.created_at) {
      judgeByAttempt.set(key, j);
    }
  }

  return attemptRows.map((a) => {
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
    };
    const j = judgeByAttempt.get(a.id);
    if (j) {
      const jPayload = j.payload as {
        cause: CauseSchemaT;
        referenced_knowledge_ids: string[];
      };
      result.judge = {
        judge_event_id: j.id,
        cause: jPayload.cause,
        referenced_knowledge_ids: jPayload.referenced_knowledge_ids ?? [],
        created_at: j.created_at,
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
    .orderBy(desc(event.created_at))
    .limit(1);
  const j = rows[0];
  if (!j) return null;
  const jPayload = j.payload as {
    cause: CauseSchemaT;
    referenced_knowledge_ids: string[];
  };
  return {
    judge_event_id: j.id,
    cause: jPayload.cause,
    referenced_knowledge_ids: jPayload.referenced_knowledge_ids ?? [],
    created_at: j.created_at,
  };
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
    .limit(limit);

  return rows.map((r) => {
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
// getEventById — single event lookup (caused_by chain navigation).
// ============================================================================

/**
 * Fetches one event by id and returns the parsed KnownEvent shape (validated
 * via parseEvent — failures throw, never silently swallowed). Returns null
 * when the row is absent. The DB row's id / session_id / created_at envelope
 * fields are stripped here; parseEvent only validates Lane B's user payload
 * shape (action / subject / outcome / payload + base optional fields).
 */
export async function getEventById(db: DbLike, id: string): Promise<EventT | null> {
  const rows = await db.select().from(event).where(eq(event.id, id)).limit(1);
  const row = rows[0];
  if (!row) return null;
  return parseEvent({
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
  });
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
  task_run_id?: string | null;
  cost_micro_usd?: number | null;
  created_at?: Date;
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
      task_run_id: input.task_run_id ?? null,
      cost_micro_usd: input.cost_micro_usd ?? null,
      created_at: input.created_at ?? new Date(),
    })
    .onConflictDoNothing({ target: event.id });

  // Drizzle's onConflictDoNothing returns an empty result on no-op. The caller's
  // id IS the row's id (deterministic or assigned), so return it directly.
  // First write wins — semantics documented at fn-doc.
  return input.id;
}

// suppress unused-import warning at module level (kept for future expansion)
void sql;
