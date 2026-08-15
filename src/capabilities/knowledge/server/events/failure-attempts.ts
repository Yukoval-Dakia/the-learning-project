// YUK-876 / FULL F3.7b — knowledge-owned failure-attempt evidence read models.
//
// The FailureAttempt projection family (failed attempts as knowledge-graph
// evidence, with chained judge / user_cause attribution) moved here from
// src/server/events/queries.ts, byte-identical. Shared correction-status
// active-row machinery (takeActiveRows / filterActiveRows / newerEventRow)
// stays central and is imported below.

import {
  type EffectiveTruth,
  activeEffectiveTruth,
  getEffectiveTruths,
} from '@/capabilities/practice/public';
import type { CauseCategoryT, CauseSchemaT } from '@/core/schema/event/blocks';
import {
  AttemptQuestionSnapshot,
  type AttemptQuestionSnapshotT,
} from '@/core/schema/question-evidence-snapshot';
import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';
import { filterActiveRows, newerEventRow, takeActiveRows } from '@/server/events/queries';
import { and, asc, desc, eq, gt, gte, inArray, or, sql } from 'drizzle-orm';

type DbLike = Db | Tx;
type EventRow = typeof event.$inferSelect;

// ============================================================================
// FailureAttempt — user-facing "mistake" view projected from the event stream.
// The public name predates FSRS review events and is kept for compatibility. One
// row is returned per attempt/review event with outcome='failure'; an optional
// judge event is joined via caused_by_event_id reverse lookup.
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
  question_snapshot?: AttemptQuestionSnapshotT | null;
  created_at: Date;
  correction_state: EffectiveTruth;
  judge?: FailureAttemptJudge;
  user_cause?: FailureAttemptUserCause;
};

export interface GetFailureAttemptsOpts {
  limit?: number | null;
  questionIds?: string[];
  since?: Date;
  /**
   * Include FSRS `review` rows whose outcome is failure (`again`). Defaults to
   * false so user-facing mistake/due readers keep their established attempt-only
   * distribution; nightly knowledge/research consumers opt in deliberately.
   */
  includeReviewFailures?: boolean;
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
  // YUK-583 — keyset cursor for the knowledge_edge_propose_nightly watermark
  // 续扫. When BOTH are set, only attempts strictly AFTER (afterCreatedAt,
  // afterEventId) in (created_at, id) order are returned; the id tie-break means
  // a second attempt sharing the cursor's exact created_at is not lost. Pairs
  // with `order: 'asc'` so the caller pages forward and advances the watermark to
  // the last (max) row. Every legacy caller omits these → unchanged behaviour.
  afterCreatedAt?: Date;
  afterEventId?: string;
  // YUK-583 — scan direction for the non-perQuestion path. Default 'desc'
  // preserves the newest-first window every existing caller relies on; the
  // watermark scan passes 'asc' so a backlog > limit pages oldest-first and the
  // cursor advances only to the last event actually processed (never to `now`).
  order?: 'asc' | 'desc';
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

/**
 * YUK-562 — the attempt payload's process-data self-report ("how the learner
 * thought"), or null when the attempt carries no process text. Kept OFF the
 * {@link FailureAttempt} bare type on purpose (that shape is a stable contract
 * downstream consumers depend on); readers that want the trace opt in via the
 * wrapper shape below.
 */
function reasoningTraceFromRow(row: EventRow): string | null {
  const trace = (row.payload as { reasoning_trace?: unknown } | null)?.reasoning_trace;
  return typeof trace === 'string' ? trace : null;
}

function failureEvidenceFromRow(row: EventRow): {
  answer_md: string | null;
  answer_image_refs: string[];
  referenced_knowledge_ids: string[];
  /** undefined = historical absence; null = present but invalid/corrupt. */
  question_snapshot: AttemptQuestionSnapshotT | null | undefined;
} {
  const payload = row.payload as {
    answer_md?: string | null;
    user_response_md?: string | null;
    answer_image_refs?: string[];
    referenced_knowledge_ids?: string[];
    question_snapshot?: unknown;
  };
  const parsedSnapshot =
    payload.question_snapshot === undefined
      ? undefined
      : AttemptQuestionSnapshot.safeParse(payload.question_snapshot);
  let questionSnapshot: AttemptQuestionSnapshotT | null | undefined;
  if (parsedSnapshot === undefined) {
    questionSnapshot = undefined;
  } else {
    let invalidReason: 'schema_invalid' | 'subject_mismatch' | null;
    if (!parsedSnapshot.success) {
      invalidReason = 'schema_invalid';
    } else if (parsedSnapshot.data.question.question_id !== row.subject_id) {
      invalidReason = 'subject_mismatch';
    } else {
      invalidReason = null;
    }
    if (invalidReason !== null) {
      questionSnapshot = null;
      console.warn('[failure-attempt] invalid question snapshot omitted', {
        attempt_event_id: row.id,
        question_id: row.subject_id,
        reason: invalidReason,
      });
    } else {
      questionSnapshot = parsedSnapshot.data;
    }
  }
  return {
    // FSRS reviews call the same learner evidence `user_response_md`; normalize
    // it onto the legacy mistake projection so every downstream consumer sees
    // the answer rather than a false null.
    answer_md:
      row.action === 'review' ? (payload.user_response_md ?? null) : (payload.answer_md ?? null),
    answer_image_refs: payload.answer_image_refs ?? [],
    referenced_knowledge_ids: payload.referenced_knowledge_ids ?? [],
    question_snapshot: questionSnapshot,
  };
}

/**
 * Returns failed attempts and, when includeReviewFailures is enabled, failed
 * FSRS reviews (with chained judges populated when present), ordered by
 * created_at desc. Default limit 100 matches legacy RECENT_MISTAKES_LIMIT.
 *
 * Two queries + JS join (vs single subquery): clearer code, well-bounded by limit.
 * Judge lookup uses `event_caused_by_idx`. Filter must keep outcome='failure' —
 * the event stream stores successes too.
 */
export async function getFailureAttempts(
  db: DbLike,
  opts: GetFailureAttemptsOpts = {},
): Promise<FailureAttempt[]> {
  return (await loadFailureAttempts(db, opts)).map((row) => row.failure);
}

/**
 * YUK-786 — the LIST sibling of {@link getFailureAttemptWithReasoningTraceById}:
 * the same rows {@link getFailureAttempts} returns, each paired with the attempt
 * payload's `reasoning_trace` (YUK-562 process data). Same wrapper shape as the
 * by-id reader, for the same reason: the exported {@link FailureAttempt} type is
 * a stable contract and must NOT grow a field, so the trace rides alongside it.
 *
 * No extra round-trip — the trace is derived from the SAME attempt rows the base
 * reader already selects. The nightly 教研例会 job uses this so conjecture
 * induction can see the learner's own account of how they thought, which is the
 * single most load-bearing piece of first-hand evidence for a mind-model claim.
 */
export async function getFailureAttemptsWithReasoningTrace(
  db: DbLike,
  opts: GetFailureAttemptsOpts = {},
): Promise<FailureAttemptWithReasoningTrace[]> {
  return loadFailureAttempts(db, opts);
}

/** {@link FailureAttempt} + the opt-in YUK-562 process-data self-report. */
export type FailureAttemptWithReasoningTrace = {
  failure: FailureAttempt;
  reasoning_trace: string | null;
};

async function loadFailureAttempts(
  db: DbLike,
  opts: GetFailureAttemptsOpts = {},
): Promise<FailureAttemptWithReasoningTrace[]> {
  const unbounded = opts.limit === null;
  const limit = opts.limit ?? DEFAULT_FAILURE_ATTEMPTS_LIMIT;
  const perQuestionLimit = opts.perQuestionLimit;
  if (perQuestionLimit !== undefined && perQuestionLimit <= 0) return [];
  if (perQuestionLimit === undefined && !unbounded && limit <= 0) return [];
  const conditions = [
    opts.includeReviewFailures
      ? inArray(event.action, ['attempt', 'review'])
      : eq(event.action, 'attempt'),
    eq(event.subject_kind, 'question'),
    eq(event.outcome, 'failure'),
  ];
  if (opts.questionIds && opts.questionIds.length > 0) {
    conditions.push(inArray(event.subject_id, opts.questionIds));
  }
  if (opts.since) {
    conditions.push(gte(event.created_at, opts.since));
  }
  // YUK-583 — keyset cursor predicate: strict "(created_at, id) > (afterCreatedAt,
  // afterEventId)" so the row at the exact cursor is excluded but a DIFFERENT row
  // sharing the cursor's created_at (larger id) is still returned (no same-instant
  // event loss). Lives in `conditions` so both the main query and the
  // takeActiveRows offset loop share it. Only applied when BOTH cursor parts are set.
  if (opts.afterCreatedAt !== undefined && opts.afterEventId !== undefined) {
    const cursorPredicate = or(
      gt(event.created_at, opts.afterCreatedAt),
      and(eq(event.created_at, opts.afterCreatedAt), gt(event.id, opts.afterEventId)),
    );
    if (cursorPredicate) conditions.push(cursorPredicate);
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
    // YUK-583 — 'asc' (oldest first) for the watermark scan so a backlog > limit
    // pages forward deterministically; default 'desc' keeps the legacy
    // newest-first window for every other caller. Both the main query and the
    // takeActiveRows offset loop must share the SAME order.
    const orderBy =
      (opts.order ?? 'desc') === 'asc'
        ? [asc(event.created_at), asc(event.id)]
        : [desc(event.created_at), desc(event.id)];
    const attemptQuery = db
      .select()
      .from(event)
      .where(and(...conditions))
      .orderBy(...orderBy);
    const attemptRows = unbounded ? await attemptQuery : await attemptQuery.limit(limit * 3);

    if (attemptRows.length === 0) return [];

    activeAttemptRows = unbounded
      ? await filterActiveRows(db, attemptRows)
      : await takeActiveRows(db, attemptRows, limit, async (nextLimit, offset) =>
          db
            .select()
            .from(event)
            .where(and(...conditions))
            .orderBy(...orderBy)
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
    const evidence = failureEvidenceFromRow(a);
    const result: FailureAttempt = {
      attempt_event_id: a.id,
      question_id: a.subject_id,
      answer_md: evidence.answer_md,
      answer_image_refs: evidence.answer_image_refs,
      referenced_knowledge_ids: evidence.referenced_knowledge_ids,
      question_snapshot: evidence.question_snapshot,
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
    // YUK-786 — derived from the SAME row (no second query); the bare projection
    // above stays byte-identical for every legacy caller.
    return { failure: result, reasoning_trace: reasoningTraceFromRow(a) };
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
  return (await loadFailureAttemptById(db, attemptEventId))?.failure ?? null;
}

/**
 * YUK-562 — same SINGLE-QUERY load as {@link getFailureAttemptById}, additionally
 * surfacing the attempt payload's `reasoning_trace` (process-data self-report) so
 * the copilot `attribute_mistake` caller can feed it into attribution WITHOUT a
 * second round-trip. The exported {@link FailureAttempt} shape is deliberately
 * unchanged (downstream consumers depend on it); the trace rides alongside it in
 * the wrapper object. `reasoning_trace` is `null` when the attempt carries no
 * process text.
 */
export async function getFailureAttemptWithReasoningTraceById(
  db: DbLike,
  attemptEventId: string,
): Promise<FailureAttemptWithReasoningTrace | null> {
  return loadFailureAttemptById(db, attemptEventId);
}

/**
 * Shared single-query loader behind {@link getFailureAttemptById} and
 * {@link getFailureAttemptWithReasoningTraceById}. Runs ONE select of the full
 * attempt row and derives both the FailureAttempt projection and the raw
 * payload's reasoning_trace from it — so the reasoning_trace is available without
 * a second round-trip.
 */
async function loadFailureAttemptById(
  db: DbLike,
  attemptEventId: string,
): Promise<FailureAttemptWithReasoningTrace | null> {
  const rows = await db.select().from(event).where(eq(event.id, attemptEventId)).limit(1);
  const attempt = rows[0];
  if (!attempt) return null;
  if (
    (attempt.action !== 'attempt' && attempt.action !== 'review') ||
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

  const evidence = failureEvidenceFromRow(attempt);
  const [judge, userCause] = await Promise.all([
    getJudgeForAttempt(db, attempt.id),
    getUserCauseForAttempt(db, attempt.id),
  ]);
  const failure: FailureAttempt = {
    attempt_event_id: attempt.id,
    question_id: attempt.subject_id,
    answer_md: evidence.answer_md,
    answer_image_refs: evidence.answer_image_refs,
    referenced_knowledge_ids: evidence.referenced_knowledge_ids,
    question_snapshot: evidence.question_snapshot,
    created_at: attempt.created_at,
    correction_state: attemptTruth,
  };
  if (judge) failure.judge = judge;
  if (userCause) failure.user_cause = userCause;
  // YUK-562 — derive reasoning_trace from the SAME row (no extra query). Null when
  // the attempt has no process text; the copilot caller trims/omits empty values.
  return { failure, reasoning_trace: reasoningTraceFromRow(attempt) };
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
