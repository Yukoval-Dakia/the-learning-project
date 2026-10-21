// Failure-attempt evidence read models: failed attempts as knowledge-graph evidence
// with chained judge / user_cause attribution. Shared active-row machinery comes from
// @/kernel/events.

import { type SQL, and, asc, desc, eq, gt, gte, inArray, lt, or, sql } from 'drizzle-orm';
import type { CauseCategoryT, CauseSchemaT } from '@/core/schema/event/blocks';
import {
  AttemptQuestionSnapshot,
  type AttemptQuestionSnapshotT,
} from '@/core/schema/question-evidence-snapshot';
import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';
import {
  type EffectiveTruth,
  activeEffectiveTruth,
  filterActiveRows,
  getEffectiveTruths,
  newerEventRow,
} from '@/kernel/events';

import {
  type NativeAttemptVerdict,
  nativeAttemptOutcome,
  resolveVerdictsForAttempts,
  resolveVerdictsForNativeAttempts,
} from './assessment-verdict';

type DbLike = Db | Tx;
type EventRow = typeof event.$inferSelect;

// ============================================================================
// User-facing "mistake" view projected from the event stream. The public name
// predates FSRS reviews; one row per failed attempt/review, with an optional
// chained judge.
// ============================================================================

export type FailureAttemptJudge = {
  judge_event_id: string;
  cause: CauseSchemaT;
  referenced_knowledge_ids: string[];
  created_at: Date;
  correction_state: EffectiveTruth;
};

// User attribution lives alongside judge; projection callers prefer user_cause
// because the user has the last word on attribution.
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
  /**
   * Earliest raw judge receipt for this attempt, unchained. judge is the
   * chain-resolved effective one; the two coexist.
   */
  original_judge?: FailureAttemptJudge | null;
  assessment?: Pick<
    NativeAttemptVerdict['submission'],
    'submission_id' | 'revision_id' | 'response_set' | 'group_evidence'
  > & {
    evaluation_group_id: string;
    original_evaluation_id: string | null;
    effective_evaluation_id: string | null;
  };
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
  // Per-question cap. SQL partitions with ROW_NUMBER and over-samples 3x for
  // retracted rows; the final cap is applied after active filtering. Mutually
  // exclusive with limit.
  perQuestionLimit?: number;
  // Keyset cursor for the nightly watermark scan: strict (created_at, id) order,
  // paired with order: 'asc'. Legacy callers omit both.
  afterCreatedAt?: Date;
  afterEventId?: string;
  // Scan direction. Default 'desc' keeps the newest-first window; the watermark
  // scan uses 'asc' so a backlog pages oldest-first.
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
 * Attempt payload's process self-report, or null. Kept off FailureAttempt so the
 * stable public shape does not grow; callers opt in through the wrapper.
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
  if (row.action === 'experimental:assessment_attempt') {
    return {
      answer_md: typeof row.payload.response_md === 'string' ? row.payload.response_md : null,
      answer_image_refs: [],
      referenced_knowledge_ids: [],
      // Never substitute today's question for a native frozen assessment.
      question_snapshot: null,
    };
  }
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
    // FSRS reviews call the answer user_response_md; normalize it onto the legacy
    // projection so downstream consumers see the answer.
    answer_md:
      row.action === 'review' ? (payload.user_response_md ?? null) : (payload.answer_md ?? null),
    answer_image_refs: payload.answer_image_refs ?? [],
    referenced_knowledge_ids: payload.referenced_knowledge_ids ?? [],
    question_snapshot: questionSnapshot,
  };
}

/**
 * Failed attempts (and optionally failed FSRS reviews), newest first, with chained
 * judges populated. Default limit 100.
 */
export async function getFailureAttempts(
  db: DbLike,
  opts: GetFailureAttemptsOpts = {},
): Promise<FailureAttempt[]> {
  return (await loadFailureAttempts(db, opts)).map((row) => row.failure);
}

/**
 * List sibling of the by-id trace reader. Same rows plus reasoning_trace, with no
 * extra query; the bare FailureAttempt shape stays stable.
 */
export async function getFailureAttemptsWithReasoningTrace(
  db: DbLike,
  opts: GetFailureAttemptsOpts = {},
): Promise<FailureAttemptWithReasoningTrace[]> {
  return loadFailureAttempts(db, opts);
}

/** {@link FailureAttempt} plus the opt-in process-data self-report. */
export type FailureAttemptWithReasoningTrace = {
  failure: FailureAttempt;
  reasoning_trace: string | null;
};

function nativeFailureReference(
  value: NativeAttemptVerdict | undefined,
): FailureAttempt['assessment'] {
  if (!value) return undefined;
  const sub = value.submission;
  return {
    submission_id: sub.submission_id,
    revision_id: sub.revision_id,
    response_set: sub.response_set,
    group_evidence: sub.group_evidence,
    evaluation_group_id: value.evaluation_group_id,
    original_evaluation_id: value.original_evaluation_id,
    effective_evaluation_id: value.effective?.evaluation_id ?? null,
  };
}

async function filterActiveFailureRows(
  db: DbLike,
  rows: EventRow[],
  currentOnly = false,
): Promise<EventRow[]> {
  const active = await filterActiveRows(db, rows);
  const native = await resolveVerdictsForNativeAttempts(db, active);
  const legacy = await resolveVerdictsForAttempts(
    db,
    currentOnly
      ? active
          .filter((row) => row.action !== 'experimental:assessment_attempt')
          .map((row) => row.id)
      : [],
  );
  return active.filter((row) => {
    if (row.action === 'experimental:assessment_attempt')
      return nativeAttemptOutcome(native.get(row.id)) === 'failure';
    return legacy.get(row.id)?.effective?.verdict.coarse_outcome !== 'correct';
  });
}

async function loadFailureAttempts(
  db: DbLike,
  opts: GetFailureAttemptsOpts = {},
  currentOnly = false,
): Promise<FailureAttemptWithReasoningTrace[]> {
  const unbounded = opts.limit === null;
  const limit = opts.limit ?? DEFAULT_FAILURE_ATTEMPTS_LIMIT;
  const perQuestionLimit = opts.perQuestionLimit;
  if (perQuestionLimit !== undefined && perQuestionLimit <= 0) return [];
  if (perQuestionLimit === undefined && !unbounded && limit <= 0) return [];
  const conditions = [
    or(
      and(
        opts.includeReviewFailures
          ? inArray(event.action, ['attempt', 'review'])
          : eq(event.action, 'attempt'),
        eq(event.outcome, 'failure'),
      ),
      eq(event.action, 'experimental:assessment_attempt'),
    ),
    eq(event.subject_kind, 'question'),
  ];
  if (opts.questionIds && opts.questionIds.length > 0) {
    conditions.push(inArray(event.subject_id, opts.questionIds));
  }
  if (opts.since) {
    conditions.push(gte(event.created_at, opts.since));
  }
  // Strict (created_at, id) cursor: the row at the cursor is excluded, but a
  // same-instant row with a larger id is kept.
  if (opts.afterCreatedAt !== undefined && opts.afterEventId !== undefined) {
    const cursorPredicate = or(
      gt(event.created_at, opts.afterCreatedAt),
      and(eq(event.created_at, opts.afterCreatedAt), gt(event.id, opts.afterEventId)),
    );
    if (cursorPredicate) conditions.push(cursorPredicate);
  }
  // Secondary id order makes same-instant attempts deterministic across requests.
  let activeAttemptRows: EventRow[];

  if (perQuestionLimit !== undefined) {
    // Partition per question so a hot question cannot saturate a global limit and
    // drop quieter ones. Over-sample 3x for retracted heads, then keep fetching
    // deeper windows until every requested question has its cap.
    const partitionBatchLimit = Math.min(perQuestionLimit * 3, 300);
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
      const filtered = await filterActiveFailureRows(db, attemptRows, currentOnly);
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
    const ascending = opts.order === 'asc';
    const orderBy = ascending
      ? [asc(event.created_at), asc(event.id)]
      : [desc(event.created_at), desc(event.id)];
    const batchSize = unbounded ? 300 : Math.min(limit * 3, 300);
    activeAttemptRows = [];
    let cursor: EventRow | undefined;
    for (;;) {
      const compare = ascending ? gt : lt;
      const cursorCondition = cursor
        ? or(
            compare(event.created_at, cursor.created_at),
            and(eq(event.created_at, cursor.created_at), compare(event.id, cursor.id)),
          )
        : undefined;
      const rows = await db
        .select()
        .from(event)
        .where(and(...conditions, cursorCondition))
        .orderBy(...orderBy)
        .limit(batchSize);
      if (rows.length === 0) break;
      activeAttemptRows.push(...(await filterActiveFailureRows(db, rows, currentOnly)));
      if ((!unbounded && activeAttemptRows.length >= limit) || rows.length < batchSize) break;
      cursor = rows.at(-1);
    }
    if (!unbounded) activeAttemptRows = activeAttemptRows.slice(0, limit);
  }

  if (activeAttemptRows.length === 0) return [];

  const attemptIds = activeAttemptRows.map((r) => r.id);
  // One round-trip fetches judge and user_cause events, which chain via subject_id
  // or caused_by_event_id. Both anchors are needed: appeals set caused_by to the
  // appeal, while historical attribution sets caused_by to the attempt.
  const chainedRows = await db
    .select()
    .from(event)
    .where(
      and(
        eq(event.subject_kind, 'event'),
        or(inArray(event.subject_id, attemptIds), inArray(event.caused_by_event_id, attemptIds)),
        inArray(event.action, ['judge', 'experimental:user_cause']),
      ),
    );
  const effectiveChainedRows = await resolveEffectiveActiveRows(db, chainedRows);
  const attemptTruths = await getEffectiveTruths(db, attemptIds);
  const attemptIdSet = new Set(attemptIds);

  // Keep newest per (action, attempt) group.
  const judgeByAttempt = new Map<string, { row: EventRow; truth: EffectiveTruth }>();
  const userCauseByAttempt = new Map<string, { row: EventRow; truth: EffectiveTruth }>();
  // Earliest raw judge per attempt, kept separately from the effective judge.
  const originalJudgeRowByAttempt = new Map<string, EventRow>();
  // subject_id wins: appeal re-judgments set it to the attempt. Otherwise
  // caused_by is the historical attribution anchor.
  const anchorKeyFor = (row: EventRow): string | null => {
    if (row.subject_id !== null && attemptIdSet.has(row.subject_id)) return row.subject_id;
    if (row.caused_by_event_id !== null && attemptIdSet.has(row.caused_by_event_id)) {
      return row.caused_by_event_id;
    }
    return null;
  };
  for (const originalRow of chainedRows) {
    const key = anchorKeyFor(originalRow);
    if (key === null) continue;
    if (originalRow.action === 'judge') {
      const prev = originalJudgeRowByAttempt.get(key);
      // Keep the earliest row.
      if (!prev || newerEventRow(prev, originalRow)) {
        originalJudgeRowByAttempt.set(key, originalRow);
      }
    }
    const effective = effectiveChainedRows.get(originalRow.id);
    if (!effective) continue;
    const bucket = effective.row.action === 'judge' ? judgeByAttempt : userCauseByAttempt;
    const existing = bucket.get(key);
    if (!existing || newerEventRow(effective.row, existing.row)) {
      bucket.set(key, effective);
    }
  }
  // Resolve each raw judge's own chain truth so correction_state reflects later
  // reversals.
  const originalJudgeTruths = await getEffectiveTruths(
    db,
    [...originalJudgeRowByAttempt.values()].map((r) => r.id),
  );

  const nativeVerdicts = await resolveVerdictsForNativeAttempts(db, activeAttemptRows);
  return activeAttemptRows.map((a) => {
    const evidence = failureEvidenceFromRow(a);
    const result: FailureAttempt = {
      ...(nativeVerdicts.has(a.id)
        ? { assessment: nativeFailureReference(nativeVerdicts.get(a.id)) }
        : {}),
      attempt_event_id: a.id,
      question_id: a.subject_id,
      answer_md: evidence.answer_md,
      answer_image_refs: evidence.answer_image_refs,
      referenced_knowledge_ids:
        nativeVerdicts.get(a.id)?.knowledge_ids ?? evidence.referenced_knowledge_ids,
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
    const oj = originalJudgeRowByAttempt.get(a.id);
    if (oj) {
      const ojPayload = oj.payload as {
        cause: CauseSchemaT;
        referenced_knowledge_ids: string[];
      };
      result.original_judge = {
        judge_event_id: oj.id,
        cause: ojPayload.cause,
        referenced_knowledge_ids: ojPayload.referenced_knowledge_ids ?? [],
        created_at: oj.created_at,
        correction_state: originalJudgeTruths.get(oj.id) ?? activeEffectiveTruth(oj.id),
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
    // Derived from the same row; the bare projection stays byte-identical.
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
 * By-id sibling of the trace reader: one query, with the trace alongside the
 * unchanged FailureAttempt shape.
 */
export async function getFailureAttemptWithReasoningTraceById(
  db: DbLike,
  attemptEventId: string,
): Promise<FailureAttemptWithReasoningTrace | null> {
  return loadFailureAttemptById(db, attemptEventId);
}

/**
 * Shared single-query loader: derives both the projection and reasoning_trace from
 * one attempt row, so no second round-trip is needed.
 */
async function loadFailureAttemptById(
  db: DbLike,
  attemptEventId: string,
): Promise<FailureAttemptWithReasoningTrace | null> {
  const rows = await db.select().from(event).where(eq(event.id, attemptEventId)).limit(1);
  const attempt = rows[0];
  if (!attempt) return null;
  if (
    (attempt.action !== 'attempt' &&
      attempt.action !== 'review' &&
      attempt.action !== 'experimental:assessment_attempt') ||
    attempt.subject_kind !== 'question' ||
    (attempt.action !== 'experimental:assessment_attempt' && attempt.outcome !== 'failure')
  ) {
    return null;
  }

  const attemptTruth =
    (await getEffectiveTruths(db, [attempt.id])).get(attempt.id) ??
    activeEffectiveTruth(attempt.id);
  if (attemptTruth.terminal_state !== 'active' || attemptTruth.effective_event_id !== attempt.id) {
    return null;
  }

  const native = await resolveVerdictsForNativeAttempts(db, [attempt]);
  if (attempt.action === 'experimental:assessment_attempt') {
    if (nativeAttemptOutcome(native.get(attempt.id)) !== 'failure') return null;
  }
  const evidence = failureEvidenceFromRow(attempt);
  // Pull all judge rows once (subject_id or caused_by anchor, oldest first) and
  // derive both the earliest receipt and the newest live effective judge.
  const judgeRows = await db
    .select()
    .from(event)
    .where(
      and(
        eq(event.action, 'judge'),
        eq(event.subject_kind, 'event'),
        or(eq(event.subject_id, attempt.id), eq(event.caused_by_event_id, attempt.id)),
      ),
    )
    .orderBy(asc(event.created_at), asc(event.dispatch_seq), asc(event.id));
  const [effectiveJudgeRows, originalJudgeTruths, userCause] = await Promise.all([
    resolveEffectiveActiveRows(db, judgeRows),
    judgeRows.length > 0
      ? getEffectiveTruths(
          db,
          judgeRows.map((r) => r.id),
        )
      : Promise.resolve(new Map<string, EffectiveTruth>()),
    getUserCauseForAttempt(db, attempt.id),
  ]);
  // earliestJudge is the first row in created_at order.
  const earliestJudge = judgeRows[0];
  // effective judge is the newest row still live after chain resolution.
  let judge: FailureAttemptJudge | null = null;
  let judgeRow: EventRow | null = null;
  for (const originalRow of judgeRows) {
    const effective = effectiveJudgeRows.get(originalRow.id);
    if (!effective) continue;
    if (
      effective.row.subject_id !== attempt.id &&
      effective.row.caused_by_event_id !== attempt.id
    ) {
      continue;
    }
    if (!judgeRow || newerEventRow(effective.row, judgeRow)) {
      judgeRow = effective.row;
      const p = effective.row.payload as {
        cause: CauseSchemaT;
        referenced_knowledge_ids: string[];
      };
      judge = {
        judge_event_id: effective.row.id,
        cause: p.cause,
        referenced_knowledge_ids: p.referenced_knowledge_ids ?? [],
        created_at: effective.row.created_at,
        correction_state: effective.truth,
      };
    }
  }
  const failure: FailureAttempt = {
    ...(native.has(attempt.id)
      ? { assessment: nativeFailureReference(native.get(attempt.id)) }
      : {}),
    attempt_event_id: attempt.id,
    question_id: attempt.subject_id,
    answer_md: evidence.answer_md,
    answer_image_refs: evidence.answer_image_refs,
    referenced_knowledge_ids:
      native.get(attempt.id)?.knowledge_ids ?? evidence.referenced_knowledge_ids,
    question_snapshot: evidence.question_snapshot,
    created_at: attempt.created_at,
    correction_state: attemptTruth,
  };
  if (judge) failure.judge = judge;
  if (userCause) failure.user_cause = userCause;
  if (earliestJudge) {
    const ojPayload = earliestJudge.payload as {
      cause: CauseSchemaT;
      referenced_knowledge_ids: string[];
    };
    failure.original_judge = {
      judge_event_id: earliestJudge.id,
      cause: ojPayload.cause,
      referenced_knowledge_ids: ojPayload.referenced_knowledge_ids ?? [],
      created_at: earliestJudge.created_at,
      correction_state:
        originalJudgeTruths.get(earliestJudge.id) ?? activeEffectiveTruth(earliestJudge.id),
    };
  }
  // Derived from the same row; null when there is no process text. The copilot
  // caller trims or omits empty values.
  return { failure, reasoning_trace: reasoningTraceFromRow(attempt) };
}

// Per-question partition for the perQuestionLimit path. ROW_NUMBER keeps each
// question's own window; the caller applies the final cap after active filtering.
async function getPartitionedFailureRows(
  db: DbLike,
  conditions: (SQL | undefined)[],
  partitionOffset: number,
  partitionLimit: number,
): Promise<EventRow[]> {
  // The partitioned CTE reuses the same drizzle conditions and joins back on id.
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
      dispatch_seq: event.dispatch_seq,
      affected_scopes: event.affected_scopes,
      ingest_at: event.ingest_at,
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
  return rows;
}

/** Reporting view: filter current grades before applying each requested quota. */
export async function getCurrentFailureAttempts(db: DbLike, opts: GetFailureAttemptsOpts = {}) {
  // Reporting callers without a limit retain full totals, read through bounded pages.
  return (await loadFailureAttempts(db, { ...opts, limit: opts.limit ?? null }, true)).map(
    (row) => row.failure,
  );
}
