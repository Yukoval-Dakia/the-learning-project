// Phase 0 关系脑 (YUK-406 / YUK-440) — U3 probe one-shot lifecycle. This is the
// A13 conjecture-engine "dark-loop producer": the surface that materializes a
// probe question and emits the single canonical `experimental:probe_result`
// outcome event. YUK-691 additionally writes a short-lived judge-claim marker to
// close the concurrent HTTP read-then-paid-invoke race; it is audit metadata, not
// an outcome or learner-state event.
//
// THREE LOAD-BEARING INVARIANTS (the whole point of this unit):
//
//   1. POOL-INVISIBILITY — the probe question is inserted `draft_status='draft'`
//      + `source='mind_probe'`. The shared pool filter `notDraftPredicate`
//      (src/db/predicates.ts = `or(isNull(draft_status), ne(draft_status, 'draft'))`) excludes every
//      'draft' row from EVERY review pool, so a served probe NEVER appears in
//      /api/review/due. This is the recurrence regression-lock (roadmap U3).
//
//   2. ≤3 CONCURRENT ACTIVE PROBES — `MAX_CONCURRENT_ACTIVE_PROBES`. serveProbeOnce
//      reads countActiveProbes INSIDE a db.transaction and (to truly serialize two
//      concurrent serves on the count-read + insert) takes a transaction-scoped
//      advisory lock first, so the cap can never be raced past. When the cap is hit
//      it returns {status:'cap_reached'} WITHOUT inserting.
//
//   3. ND-5 — this module NEVER writes FSRS. It NEVER imports/calls upsertFsrsState
//      / scheduleReview, NEVER inserts material_fsrs_state, NEVER writes an
//      action='attempt' event. The probe question row stays draft forever, served
//      exactly once, inert thereafter. Only a CONFIRMED weakness's remediation
//      enters FSRS — via a SEPARATE question through the normal proposal
//      accept→promote path — which is NOT this module's job.
//
// CANONICAL EVENT (cross-doc reconciliation — newer roadmap WINS): the older plan
// (docs/superpowers/plans/2026-06-18-phase0-relationship-brain.md, Task 11) shows a
// two-event vocabulary `experimental:probe_served` + `experimental:probe_answered`.
// THAT IS DEPRECATED. The canonical model (docs/planning/2026-06-27-relationship-
// brain-roadmap.md U3 + docs/design/2026-06-27-a13-ts-half-design.md §2.2) is a
// SINGLE outcome event `experimental:probe_result`. There is NO serve event: the
// "served" state IS the draft question row existing. serveProbeOnce writes ONLY the
// question row. answerProbe writes exactly ONE probe_result event; the separate
// judge-claim marker is never folded as probe evidence.
//
// Escape-hatch (a13 design §2.2): `experimental:probe_result` is NOT in
// RESERVED_EXPERIMENTAL_ACTIONS — it validates through the loose generic
// ExperimentalEvent (experimental.ts:203-214) with zero schema-file change.
// Do NOT reserve it (that would force a locked schema branch).
//
// Identity (verified from U2, conjecture-accept.ts:93-94): the conjecture has NO
// separate DB row — it IS the `experimental:proposal` event, so its stable id is
// the proposalId. conjecture_event_id === conjectureProposalId.

import { newId } from '@/core/ids';
import type { Db, Tx } from '@/db/client';
import { event, question } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import { ApiError } from '@/server/http/errors';
import { withAnswerClass } from '@/server/questions/answer-class-write';
import { and, desc, eq, sql } from 'drizzle-orm';

type DbOrTx = Db | Tx;

/** The `source` value stamped on every probe question (pool-invisibility marker). */
export const PROBE_QUESTION_SOURCE = 'mind_probe' as const;

/** Hard cap on probes that are served-but-unanswered at any moment (invariant #2). */
export const MAX_CONCURRENT_ACTIVE_PROBES = 3;

/** Canonical single outcome event — loose escape hatch, NEVER reserved (§2.2). */
export const PROBE_RESULT_ACTION = 'experimental:probe_result' as const;

/** Persisted claim written before a paid probe judge invocation (YUK-691). */
export const PROBE_JUDGE_STARTED_ACTION = 'experimental:probe_judge_started' as const;
/** Compensating marker that releases a failed paid-judge claim immediately. */
export const PROBE_JUDGE_RELEASED_ACTION = 'experimental:probe_judge_released' as const;

/**
 * A failed/ambiguous judge may be retried, but not by a concurrent request burst.
 * Keeping the claim for five minutes bounds paid retries while preserving recovery
 * from a transient provider or non-discriminating result.
 */
export const PROBE_JUDGE_CLAIM_TTL_MS = 5 * 60_000;

// A fixed key for the transaction-scoped advisory lock that serializes serves.
// All probe serves contend on this single key so the count-read + insert critical
// section runs one-at-a-time (genuine ≤cap guarantee, not just READ COMMITTED hope).
const PROBE_SERVE_LOCK_KEY = 406_440_3 as const;

export interface ServeProbeOnceParams {
  // conjecture-wire #13 — acceptConjectureProposal passes its OUTER tx here so the
  // probe serve is atomic with the rate event + dark promotion hop (drizzle nests
  // `db.transaction` inside an outer tx as a SAVEPOINT; `pg_advisory_xact_lock` is
  // transaction-scoped to the OUTERMOST tx, so the cap-serialize lock holds across
  // the whole accept). Callers may also pass a top-level Db for standalone serves.
  db: DbOrTx;
  /** = the conjecture event id (proposalId). Stamped into the question provenance. */
  conjectureProposalId: string;
  /** The KC the conjecture targets; carried as the probe question's knowledge_ids. */
  knowledgeId: string;
  /** The discriminating probe text (conjecture.probe_md). */
  probeMd: string;
  /** Optional expected/reference answer. */
  referenceMd?: string | null;
  /** Question kind; neutral default. */
  kind?: string;
  /** Neutral default difficulty (3). */
  difficulty?: number;
  now?: Date;
}

export type ServeProbeOnceResult =
  | { status: 'served'; probe_question_id: string; active_count: number }
  | { status: 'cap_reached'; active_count: number };

/**
 * Count probes that are SERVED but not yet ANSWERED = `source='mind_probe'`
 * questions with NO `experimental:probe_result` event referencing them.
 * Accepts a tx so serveProbeOnce can read the count inside its transaction.
 */
export async function countActiveProbes(db: DbOrTx): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(question)
    .where(
      and(
        eq(question.source, PROBE_QUESTION_SOURCE),
        sql`NOT EXISTS (
          SELECT 1 FROM ${event}
          WHERE ${event.subject_kind} = 'question'
            AND ${event.subject_id} = ${question.id}
            AND ${event.action} = ${PROBE_RESULT_ACTION}
        )`,
      ),
    );
  return rows[0]?.n ?? 0;
}

/**
 * Materialize a probe question for a conjecture. Writes ONLY the question row (no
 * event — the "served" state IS the draft row existing). The cap check + insert run
 * inside a transaction guarded by an advisory lock so concurrent serves serialize.
 * Returns {status:'cap_reached'} without inserting when MAX_CONCURRENT_ACTIVE_PROBES
 * is already reached.
 */
export async function serveProbeOnce(params: ServeProbeOnceParams): Promise<ServeProbeOnceResult> {
  const { db, conjectureProposalId, knowledgeId, probeMd } = params;
  const now = params.now ?? new Date();
  const kind = params.kind ?? 'short_answer';
  const difficulty = params.difficulty ?? 3;
  const referenceMd = params.referenceMd ?? null;

  return db.transaction(async (tx) => {
    // Serialize the count-read + insert critical section across concurrent serves.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${PROBE_SERVE_LOCK_KEY})`);

    const activeBefore = await countActiveProbes(tx);
    if (activeBefore >= MAX_CONCURRENT_ACTIVE_PROBES) {
      return { status: 'cap_reached', active_count: activeBefore };
    }

    const probeQuestionId = newId();
    await tx.insert(question).values(
      withAnswerClass({
        id: probeQuestionId,
        kind,
        prompt_md: probeMd,
        reference_md: referenceMd,
        knowledge_ids: [knowledgeId],
        difficulty,
        // YUK-567 slice-2 — probes are answered with TEXT and/or IMAGE (handwriting /
        // photo). Force the multimodal_direct route so a photo (incl. photo-only) answer
        // is graded by the vision judge — a text route would 422 a photo-only answer
        // (submit.ts F4). It grades text-only answers too (its ONLY unsupported case is
        // "no answer text AND no images"), so this is strictly more capable, not narrower.
        judge_kind_override: 'multimodal_direct',
        source: PROBE_QUESTION_SOURCE,
        // Provenance: trace the probe question back to its conjecture event.
        source_ref: conjectureProposalId,
        // INVARIANT #1 (pool-invisibility / recurrence regression-lock): 'draft' so
        // notDraftPredicate (src/db/predicates.ts) excludes it from EVERY review pool, forever.
        draft_status: 'draft',
        metadata: {
          conjecture_proposal_id: conjectureProposalId,
        },
        created_at: now,
        updated_at: now,
      }),
    );

    return { status: 'served', probe_question_id: probeQuestionId, active_count: activeBefore + 1 };
  });
}

export interface AnswerProbeParams {
  db: Db;
  probeQuestionId: string;
  /** Graded correctness of the probe answer (the prediction-test outcome). */
  outcome: 0 | 1;
  /** Qualitative conjecture-lifecycle decision. */
  resolution: 'confirmed' | 'retired';
  /**
   * Phase-deferred (feedback_phase_deferred_comments): R(t) snapshot at judge time.
   * Defaults to null. The field is present NOW to keep the probe_result event shape
   * stable for future fold-replay (a13 design §修正-3 / [MEDIUM] R(t) note): U7
   * (Lane C, not yet landed) exposes a PUBLIC `retrievabilityForKc` reader, and U8
   * reconcile populates this once Lane C lands. U3 must NOT deep-import practice FSRS
   * internals (cardFromState/scheduler are private — leaking them is forbidden per
   * a13-design §修正-6), so there is no cross-lane import here to fetch it.
   */
  retrievabilityAtJudge?: number | null;
  /** Provenance — the answer text that was graded. */
  answer_md?: string | null;
  /** Provenance — the answer image refs (asset ids) that were graded (photo answers). */
  answer_image_refs?: string[];
  now?: Date;
}

export interface AnswerProbeResult {
  status: 'confirmed' | 'retired';
  /** The recorded 0|1 outcome (faithfully reported on BOTH fresh + idempotent paths). */
  outcome: 0 | 1;
  probe_result_event_id: string;
  idempotent?: boolean;
}

function parseProbeResultEvent(
  existing: Pick<typeof event.$inferSelect, 'id' | 'payload'>,
): AnswerProbeResult | null {
  const recordedResolution = (existing.payload as { resolution?: unknown }).resolution;
  const recordedOutcome = (existing.payload as { outcome?: unknown }).outcome;
  if (recordedResolution !== 'confirmed' && recordedResolution !== 'retired') return null;
  if (recordedOutcome !== 0 && recordedOutcome !== 1) return null;
  return {
    status: recordedResolution,
    outcome: recordedOutcome,
    probe_result_event_id: existing.id,
    idempotent: true,
  };
}

/**
 * Atomically claim the paid judge slot for one probe.
 *
 * The route's read-only result peek is deliberately only a fast path. This
 * transaction is the race-closing boundary: it takes the same per-probe advisory
 * lock used by `answerProbe`, re-checks for a completed result, then refuses a
 * fresh claim until its TTL expires. Therefore concurrent HTTP requests can never
 * all pass a read-then-invoke gap and multiply paid judge calls.
 */
export async function claimProbeJudging(
  db: Db,
  probeQuestionId: string,
  now: Date = new Date(),
): Promise<AnswerProbeResult | null> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${probeQuestionId}, 0))`);

    const [completed] = await tx
      .select()
      .from(event)
      .where(
        and(
          eq(event.action, PROBE_RESULT_ACTION),
          eq(event.subject_kind, 'question'),
          eq(event.subject_id, probeQuestionId),
        ),
      )
      .limit(1);
    if (completed) {
      const parsed = parseProbeResultEvent(completed);
      if (parsed) return parsed;
    }

    const [latestClaim] = await tx
      .select({ created_at: event.created_at })
      .from(event)
      .where(
        and(
          eq(event.action, PROBE_JUDGE_STARTED_ACTION),
          eq(event.subject_kind, 'question'),
          eq(event.subject_id, probeQuestionId),
        ),
      )
      .orderBy(desc(event.created_at))
      .limit(1);
    const [latestRelease] = await tx
      .select({ created_at: event.created_at })
      .from(event)
      .where(
        and(
          eq(event.action, PROBE_JUDGE_RELEASED_ACTION),
          eq(event.subject_kind, 'question'),
          eq(event.subject_id, probeQuestionId),
        ),
      )
      .orderBy(desc(event.created_at))
      .limit(1);
    const claimIsReleased =
      latestClaim !== undefined &&
      latestRelease !== undefined &&
      latestRelease.created_at.getTime() >= latestClaim.created_at.getTime();
    const claimAgeMs =
      latestClaim && !claimIsReleased ? now.getTime() - latestClaim.created_at.getTime() : null;
    if (claimAgeMs !== null && claimAgeMs < PROBE_JUDGE_CLAIM_TTL_MS) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((PROBE_JUDGE_CLAIM_TTL_MS - claimAgeMs) / 1000),
      );
      throw new ApiError(
        'probe_judge_in_progress',
        `probe ${probeQuestionId} already has a recent judge claim`,
        409,
        { 'Retry-After': String(retryAfterSeconds) },
      );
    }

    await writeEvent(tx, {
      id: newId(),
      actor_kind: 'system',
      actor_ref: 'mind_probe',
      action: PROBE_JUDGE_STARTED_ACTION,
      subject_kind: 'question',
      subject_id: probeQuestionId,
      payload: {
        expires_at: new Date(now.getTime() + PROBE_JUDGE_CLAIM_TTL_MS).toISOString(),
      },
      created_at: now,
    });
    return null;
  });
}

/** Release a failed judge claim without deleting append-only audit history. */
export async function releaseProbeJudging(
  db: Db,
  probeQuestionId: string,
  now: Date = new Date(),
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${probeQuestionId}, 0))`);
    await writeEvent(tx, {
      id: newId(),
      actor_kind: 'system',
      actor_ref: 'mind_probe',
      action: PROBE_JUDGE_RELEASED_ACTION,
      subject_kind: 'question',
      subject_id: probeQuestionId,
      payload: { released_at: now.toISOString() },
      created_at: now,
    });
  });
}

/**
 * Record the probe outcome as exactly ONE canonical `experimental:probe_result`
 * event (subject_kind='question', subject_id=probeQuestionId, caused_by=the
 * conjecture event id). Writes NOTHING else — no attempt event, no FSRS row (ND-5).
 *
 * One-shot guard / idempotency (mirrors U2 acceptConjectureProposal): if a
 * probe_result already exists for this question, no second event is written — the
 * recorded result is returned with idempotent:true. The check-existing + write run
 * inside a transaction guarded by a per-probe advisory lock (keyed on the question
 * id) so two concurrent answers on the SAME probe can never both insert — the
 * one-shot guarantee holds under concurrency, not just sequentially.
 */
export async function answerProbe(params: AnswerProbeParams): Promise<AnswerProbeResult> {
  const { db, probeQuestionId, outcome, resolution } = params;
  const now = params.now ?? new Date();
  const retrievabilityAtJudge = params.retrievabilityAtJudge ?? null;
  const answerMd = params.answer_md ?? null;
  const answerImageRefs = params.answer_image_refs ?? [];

  return db.transaction(async (tx) => {
    // Serialize concurrent answers on the SAME probe so the check-existing + write is
    // atomic (per-probe key via hashtextextended — different probes don't contend).
    // Mirrors serveProbeOnce's advisory lock; closes the read-then-write idempotency
    // gap that would otherwise let two racers each insert a probe_result event.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${probeQuestionId}, 0))`);

    // Read the probe question back to recover its conjecture provenance.
    const [probe] = await tx
      .select({ source: question.source, metadata: question.metadata })
      .from(question)
      .where(eq(question.id, probeQuestionId))
      .limit(1);
    if (!probe) {
      throw new ApiError('probe_not_found', `no probe question ${probeQuestionId}`, 404);
    }
    if (probe.source !== PROBE_QUESTION_SOURCE) {
      throw new ApiError('not_a_probe', `question ${probeQuestionId} is not a mind_probe`, 409);
    }
    const conjectureEventId = (probe.metadata as Record<string, unknown> | null)
      ?.conjecture_proposal_id;
    if (typeof conjectureEventId !== 'string' || conjectureEventId.length === 0) {
      throw new ApiError(
        'probe_missing_conjecture_ref',
        `probe ${probeQuestionId} has no conjecture_proposal_id`,
        409,
      );
    }

    // One-shot guard / idempotency: a prior probe_result short-circuits — NO second
    // event (this is how the probe stays served exactly once).
    const [existing] = await tx
      .select()
      .from(event)
      .where(
        and(
          eq(event.action, PROBE_RESULT_ACTION),
          eq(event.subject_kind, 'question'),
          eq(event.subject_id, probeQuestionId),
        ),
      )
      .limit(1);
    if (existing) {
      // Idempotent: report the RECORDED resolution faithfully — NEVER substitute the
      // current request's `resolution` (a re-answer with a different resolution must
      // not silently rewrite what the record says happened). A probe_result is always
      // written with a valid resolution; a missing/invalid one means a corrupt event
      // row (e.g. a manual DB edit), which we surface loudly rather than paper over by
      // blending in the caller's value.
      const parsed = parseProbeResultEvent(existing);
      if (!parsed) {
        throw new ApiError(
          'probe_result_corrupt',
          `probe ${probeQuestionId} has a probe_result event with an invalid resolution or outcome`,
          500,
        );
      }
      return parsed;
    }

    const probeResultEventId = newId();
    await writeEvent(tx, {
      id: probeResultEventId,
      actor_kind: 'system',
      actor_ref: 'mind_probe',
      action: PROBE_RESULT_ACTION,
      subject_kind: 'question',
      subject_id: probeQuestionId,
      // Envelope outcome intentionally left NULL — the canonical 0|1 outcome lives in
      // the payload; this event is NOT an attempt and must never look like one (ND-5).
      payload: {
        conjecture_event_id: conjectureEventId,
        outcome,
        resolution,
        retrievability_at_judge: retrievabilityAtJudge,
        answer_md: answerMd,
        // Provenance for a photo answer: the team can later see WHAT was submitted for
        // a confirmed probe ("教研团据此备练"), not just the text (evidence-first).
        answer_image_refs: answerImageRefs,
      },
      caused_by_event_id: conjectureEventId,
      created_at: now,
    });

    return { status: resolution, outcome, probe_result_event_id: probeResultEventId };
  });
}

/**
 * Non-claiming peek: read an existing `probe_result` event for a probe WITHOUT
 * judging or writing. Used by the probe-answer route to short-circuit idempotent
 * re-answers BEFORE invoking the judge (saves the LLM cost on re-answer — the
 * recorded outcome/resolution is faithful and immutable, so re-judging is pure
 * waste). Mirrors `existingAcceptRate` in the proposal-accept path.
 *
 * Returns:
 *   - the recorded `AnswerProbeResult` (idempotent: true) when a VALID probe_result
 *     exists (outcome ∈ {0,1}, resolution ∈ {confirmed,retired});
 *   - `null` when NO probe_result exists (caller proceeds to judge + answerProbe);
 *   - `null` when an existing event is CORRUPT (caller proceeds to judge + answerProbe,
 *     which surfaces the `probe_result_corrupt` 500 — the judge call is wasted on this
 *     rare manual-DB-edit edge case, acceptable vs duplicating validation here).
 *
 * ND-5: READ-ONLY (single SELECT, zero writes).
 */
export async function peekExistingProbeResult(
  db: Db,
  probeQuestionId: string,
): Promise<AnswerProbeResult | null> {
  const [existing] = await db
    .select()
    .from(event)
    .where(
      and(
        eq(event.action, PROBE_RESULT_ACTION),
        eq(event.subject_kind, 'question'),
        eq(event.subject_id, probeQuestionId),
      ),
    )
    .limit(1);
  if (!existing) return null;
  return parseProbeResultEvent(existing);
}
