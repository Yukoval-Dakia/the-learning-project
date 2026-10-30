// T4 — practice 包的提议 accept-applier 真身，从 dispatch 壳
// （actions.ts @ src/server/proposals）等价平移（搬迁不改逻辑）。壳退化为
// 纯 dispatch，按 kind 一行委托到这里。
// practice 声明归属的 proposal kinds（manifest.proposals.kinds）：
// - variant_question → acceptVariantQuestionProposal（本文件）
// - question_draft → acceptQuestionDraftProposal（本文件）
// + dismissQuestionDraftProposal（本文件，：
// dismiss tombstone 草稿行 metadata.dismissed_at）
// - judge_retraction → acceptJudgeRetractionProposal（本文件；evaluation 目标走
// appeal/rejudge/CAS 激活，legacy judge-event 目标写 CorrectEvent）。
// import 环 gate：本文件不得 import producers/writer/actions（含 type-only）；
// 共享 helper 一律走 @/kernel/proposals/applier-helpers。

import { createId } from '@paralleldrive/cuid2';
import { and, eq, sql } from 'drizzle-orm';

import { lockPlacementSupplyScopes } from '@/capabilities/practice/public';
import { newId } from '@/core/ids';
import { canonicalHash } from '@/core/migration/canonical';
import type { ScoringUnitResultT } from '@/core/schema/assessment';
import {
  ActivateEvaluationIntent,
  EvaluationProvenance,
  PublishedQuestionRevision,
  projectIssuedScoringBasis,
} from '@/core/schema/assessment';
import {
  LEGACY_DRAFT_STATUS,
  MARKING_RULE_PROVENANCE,
  QUESTION_AVAILABILITY,
} from '@/core/schema/assessment/lifecycle';
import type { QuestionEditOpT } from '@/core/schema/proposal';
import type { Db, Tx } from '@/db/client';
import { acquireLearningStateWriteLock } from '@/db/learning-state-lock';
import {
  cause_category_overlay,
  evaluation,
  event,
  mistake_variant,
  question,
  question_revision,
} from '@/db/schema';
import { getCorrectionStatus, writeEvent } from '@/kernel/events';
import { ApiError } from '@/kernel/http';
import {
  acquireProposalDecisionLock,
  asPlainRecord,
  ensureAcceptOnly,
  existingAcceptRate,
  findExistingRateEvent,
  requiredString,
  writeProposalRateEvent,
} from '@/kernel/proposals/applier-helpers';
import type { ProposalInboxRow } from '@/kernel/proposals/inbox';
import {
  ensureProposalDecisionSignal,
  recordProposalDecisionSignal,
} from '@/kernel/proposals/signals';
import { withAnswerClass } from '@/kernel/records/answer-class-write';
import { publishQuestionGroupFromRow } from '@/kernel/records/assessment-publication';
// W2 — mistake_variant accept (E2) write-through. accept already writes the rate(accept)
// event; the per-entity flag gates whether the projection (ON) or the imperative UPDATE (OFF)
// writes the row. OFF still runs the write-time fold==row parity assert.
import {
  hasMistakeVariantGenesisAnchor,
  projectMistakeVariantGuarded,
} from '@/kernel/records/mistake-variant-facts';

import { CAUSE_OVERLAY_ID_PREFIX } from './cause-overlay';
import { enrollPromotedQuestionScheduling } from './question-scheduling-enrollment';
import { applyQuestionEdit } from './question-structure-edit';

// swappable enqueue hook so DB tests can drive
// variant_question accept without spinning up pg-boss.
export type EnqueueVariantVerifyFn = (mistakeVariantId: string) => Promise<void>;

async function defaultEnqueueVariantVerify(mistakeVariantId: string): Promise<void> {
  const { getStartedBoss } = await import('@/server/boss/client');
  const boss = await getStartedBoss();
  await boss.send('variant_verify', { mistake_variant_id: mistakeVariantId });
}

export interface VariantQuestionAcceptResult {
  kind: 'variant_question';
  rate_event_id: string;
  question_id: string;
  mistake_variant_id: string;
  idempotent?: boolean;
}

// copilot-authored draft question accept.
export interface QuestionDraftAcceptResult {
  kind: 'question_draft';
  rate_event_id: string;
  question_id: string;
  idempotent?: boolean;
}

// D6-B — active-question structured node edit accept.
export interface QuestionEditAcceptResult {
  kind: 'question_edit';
  rate_event_id: string;
  question_id: string;
  // The structured-edit audit event id (the reversible before/after record);
  // null on the idempotent re-accept path (the edit already committed once).
  edit_event_id: string | null;
  // The post-edit version of the question row.
  version: number;
  idempotent?: boolean;
}

// Structural-minimal opts: the dispatch shell's AcceptAiProposalOpts is
// assignable to this (appliers must not import actions.ts for the full type).
export interface PracticeApplierOpts {
  decision?: string;
  user_note?: string;
  // swappable enqueue (DB tests inject a no-op or vi.fn).
  enqueueVariantVerify?: EnqueueVariantVerifyFn;
  // swappable rejudge enqueue (same reason as variant verify).
  enqueueRejudge?: EnqueueRejudgeFn;
}

async function loadAcceptedQuestionOrThrow(
  db: Db,
  proposalId: string,
  questionId: string,
): Promise<typeof question.$inferSelect> {
  const existing = (
    await db.select().from(question).where(eq(question.id, questionId)).limit(1)
  )[0];
  if (!existing) {
    throw new ApiError(
      'inconsistent_state',
      `proposal ${proposalId} has an accept rate event but question ${questionId} is missing; submit a new question_edit proposal or investigate the event/projection state manually`,
      500,
    );
  }
  return existing;
}

/**
 * variant_question accept materializes the question row
 * (source='mistake_variant', draft_status='active'), flips the mistake_variant
 * row from 'draft' to 'active', writes the rate event, and enqueues
 * VariantVerifyTask. The question + mistake_variant + rate-event writes share
 * one transaction so the row never sits half-materialized.
 */
export async function acceptVariantQuestionProposal(
  db: Db,
  proposalId: string,
  proposal: ProposalInboxRow,
  opts: PracticeApplierOpts,
): Promise<VariantQuestionAcceptResult> {
  if (opts.decision && opts.decision !== 'accept') {
    throw new ApiError(
      'validation_error',
      `variant_question proposal only supports accept, got ${opts.decision}`,
      400,
    );
  }

  // Already-accepted idempotency: a rate event exists.
  const existingRateRows = await db
    .select()
    .from(event)
    .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, proposalId)))
    .limit(1);
  const existingRate = existingRateRows[0];
  if (existingRate) {
    const ratePayload = existingRate.payload as { rating?: string };
    if (ratePayload.rating !== 'accept') {
      throw new ApiError(
        'conflict',
        `proposal ${proposalId} already decided as ${ratePayload.rating}`,
        409,
      );
    }
    await ensureProposalDecisionSignal(db, proposal, 'accept', opts.user_note);
    const existingMv = (
      await db
        .select()
        .from(mistake_variant)
        .where(eq(mistake_variant.proposal_event_id, proposalId))
        .limit(1)
    )[0];
    if (!existingMv?.variant_question_id) {
      // Rate was written but materialization did not complete — caller should
      // retract + re-run, not silently fix up. Surface explicitly.
      throw new ApiError(
        'inconsistent_state',
        `proposal ${proposalId} has a rate event but no materialized variant; retract + retry`,
        500,
      );
    }
    return {
      kind: 'variant_question',
      rate_event_id: existingRate.id,
      question_id: existingMv.variant_question_id,
      mistake_variant_id: existingMv.id,
      idempotent: true,
    };
  }

  const proposedChange = proposal.payload.proposed_change as {
    source_question_id?: string;
    source_attempt_event_id?: string;
    prompt_md?: string;
    reference_md?: string;
    difficulty?: number;
    knowledge_ids?: string[];
    parent_variant_id?: string;
    root_question_id?: string;
    variant_depth?: number;
  };
  if (
    !proposedChange?.prompt_md ||
    !proposedChange.reference_md ||
    typeof proposedChange.difficulty !== 'number' ||
    !proposedChange.source_question_id
  ) {
    throw new ApiError(
      'validation_error',
      `variant_question proposal ${proposalId} is missing required proposed_change fields`,
      400,
    );
  }

  const mvRows = await db
    .select()
    .from(mistake_variant)
    .where(eq(mistake_variant.proposal_event_id, proposalId))
    .limit(1);
  const mv = mvRows[0];
  if (!mv) {
    throw new ApiError(
      'not_found',
      `no mistake_variant draft row found for proposal ${proposalId}; variant_gen may not have written it`,
      404,
    );
  }
  if (mv.status !== 'draft') {
    throw new ApiError(
      'conflict',
      `mistake_variant ${mv.id} is in status ${mv.status}, expected 'draft'`,
      409,
    );
  }

  const now = new Date();
  const newQuestionId = createId();
  const rateEventId = newId();
  // W2 — gate who writes the mistake_variant ROW (the flag is read ONCE outside the tx so a
  // mid-tx env flip can't split the decision). ON → projection write-through; OFF → imperative.

  await db.transaction(async (tx) => {
    await lockPlacementSupplyScopes(tx, proposedChange.knowledge_ids ?? []);
    // lock the draft mistake_variant row FOR UPDATE before the new
    // question + rate event + ROW write. projectMistakeVariantGuarded has no version-CAS (the table
    // has no version column), so the lock is the sole serializer: it stops a concurrent
    // dismiss/verify/retract of the same mv from interleaving between this accept's rate event and
    // its project step (a later gather would otherwise miss an uncommitted event → stale fold → row
    // drift). Makes the read→fold→write-through atomic per mv id. No-op cost on the OFF path.
    await tx
      .select({ id: mistake_variant.id })
      .from(mistake_variant)
      .where(eq(mistake_variant.id, mv.id))
      .for('update');
    await tx.insert(question).values(
      withAnswerClass({
        id: newQuestionId,
        kind: 'short_answer',
        prompt_md: proposedChange.prompt_md as string,
        reference_md: proposedChange.reference_md ?? null,
        knowledge_ids: proposedChange.knowledge_ids ?? [],
        difficulty: proposedChange.difficulty as number,
        source: 'mistake_variant',
        draft_status: LEGACY_DRAFT_STATUS.ACTIVE,
        variant_depth: proposedChange.variant_depth ?? 1,
        root_question_id: proposedChange.root_question_id ?? null,
        parent_variant_id: proposedChange.parent_variant_id ?? null,
        created_by: {
          by: 'ai',
          task_kind: 'VariantGenTask',
          propose_event_id: proposalId,
        } as never,
        created_at: now,
        updated_at: now,
      }),
    );

    // Unified publish chain (mistake_variant rows): accept publishes immediately; never
    // skip publish and go active. The variant reference answer is an AI proposal accepted by
    // a user, so it carries manual provenance (manual != official); the acceptor is the
    // human verification gate.
    await publishQuestionGroupFromRow(tx, {
      rootId: newQuestionId,
      admission: {
        state: 'admitted',
        evidence: {
          marking_provenance: MARKING_RULE_PROVENANCE.MANUAL,
          verification: {
            structural_check_passed: true,
            independent_verification: {
              passed: true,
              verifier: 'human',
              verified_at: now.toISOString(),
            },
          },
          model_slice: null,
        },
      },
      // 人工接受 ⇒ 同版复核通过：清 verify_hold 恢复准入。
      suspension: { suspended: false },
      verification: {
        // 人工接受即核验（verifier: human —— 与上方 admission evidence 同源）。
        policy_id: 'proposal_accept@1',
        outcome: 'passed',
        evidence: { verifier: 'human', proposal_kind: 'mistake_variant' },
      },
      availability: QUESTION_AVAILABILITY.GENERAL_POOL,
      actorRef: 'proposal-accept:mistake_variant',
      now,
    });

    // The accept `rate` event — written BEFORE the row write-through so the fold (when the flag is
    // ON) sees the chained accept in the same tx and projects status='active' +
    // variant_question_id=materialized_question_id (E2). caused_by = the proposal (the chain key).
    await writeEvent(tx, {
      id: rateEventId,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'rate',
      subject_kind: 'event',
      subject_id: proposalId,
      outcome: 'success',
      payload: {
        rating: 'accept',
        ...(opts.user_note ? { user_note: opts.user_note } : {}),
        materialized_question_id: newQuestionId,
        mistake_variant_id: mv.id,
      },
      caused_by_event_id: proposalId,
      created_at: now,
    });
    // Materialize canonical structural state from the events in this transaction.
    if (!(await hasMistakeVariantGenesisAnchor(tx, mv.id))) {
      throw new Error(`Variant ${mv.id} needs canonical projection migration`);
    }
    await projectMistakeVariantGuarded(tx, mv.id);
  });

  await recordProposalDecisionSignal(db, proposal, 'accept', opts.user_note);

  const enqueue = opts.enqueueVariantVerify ?? defaultEnqueueVariantVerify;
  try {
    await enqueue(mv.id);
  } catch (err) {
    // Mirror attribution_followup → variant_gen wiring: enqueue failure must
    // not roll back the accepted variant. Operator can re-enqueue later.
    console.error('[acceptVariantQuestionProposal] enqueue variant_verify failed', err);
  }

  return {
    kind: 'variant_question',
    rate_event_id: rateEventId,
    question_id: newQuestionId,
    mistake_variant_id: mv.id,
  };
}

/**
 * question_draft accept. The draft question row
 * was INSERTed at propose time (runQuestionAuthor, same tx as the proposal —
 * 决定4); accept PROMOTES it: draft_status='draft' → 'active' + per-knowledge
 * FSRS enroll-if-absent (copied from the quiz_verify promotion path, the one
 * other place a draft enters the pool) + the rate event, all in one
 * transaction. Idempotency keys on caused_by_event_id = proposalId
 * (existingAcceptRate), like every sibling accept handler.
 *
 * Dismiss flows through the dedicated questionDraftProposalDismissApplier
 * (, declared in manifest.proposals.kinds): the draft row stays inert
 * (draft_status='draft', never pooled / FSRS'd) AND is tombstoned via
 * metadata.dismissed_at so it stops reading as a live draft — search_bank /
 * listQuestions / the draft-review pool exclude it and write_quiz's narrow
 * draft gate refuses it. A new draft_status value was deliberately NOT
 * introduced: the pool-visibility predicate is fail-open (`<> 'draft'`), so a
 * 'dismissed' literal would leak the row back into every pool read
 * (src/capabilities/practice/server/question-bank-write.ts header — same reason archive uses
 * metadata.archived_at).
 */
export async function acceptQuestionDraftProposal(
  db: Db,
  proposalId: string,
  proposal: ProposalInboxRow,
  opts: PracticeApplierOpts,
): Promise<QuestionDraftAcceptResult> {
  ensureAcceptOnly('question_draft', opts);
  const change = asPlainRecord(proposal.payload.proposed_change);
  const questionId = requiredString(change.question_id, 'question_id', proposalId);

  const loadPromotedRowOrThrow = async (dbLike: Db | Tx) => {
    const existing = (
      await dbLike.select().from(question).where(eq(question.id, questionId)).limit(1)
    )[0];
    if (!existing || existing.draft_status === LEGACY_DRAFT_STATUS.DRAFT) {
      // Rate was written but the promotion did not complete — surface explicitly
      // rather than silently fixing up (variant_question precedent).
      throw new ApiError(
        'inconsistent_state',
        `proposal ${proposalId} has an accept rate event but question ${questionId} is ${existing ? 'still draft' : 'missing'}; retract + retry`,
        500,
      );
    }
    return existing;
  };

  // Already-accepted idempotency fast path (a rate event exists; 409s on a
  // non-accept decision inside existingAcceptRate). The transaction below
  // re-checks under the decision lock — this read is only a cheap short-circuit.
  const existingRate = await existingAcceptRate(db, proposalId);
  if (existingRate) {
    await ensureProposalDecisionSignal(db, proposal, 'accept', opts.user_note);
    await loadPromotedRowOrThrow(db);
    return {
      kind: 'question_draft',
      rate_event_id: existingRate.id,
      question_id: questionId,
      idempotent: true,
    };
  }

  const now = new Date();
  const rateEventId = newId();

  // review the decision check AND the promotion run
  // under the SAME lock the dismiss applier + the generic dismiss/retract
  // paths take (acquireProposalDecisionLock). Without it a racing dismiss or
  // retract could commit a second terminal decision alongside this accept, and
  // a dismiss that landed first would leave this accept promoting a row still
  // carrying metadata.dismissed_at (active-but-filtered). Mirrors the
  // question_edit accept shape: lock → re-read the decision → correction
  // guard → row-locked gates → mutation → rate event.
  const concurrentDecision = await db.transaction(async (tx) => {
    await acquireProposalDecisionLock(tx, proposalId);
    const decision = await findExistingRateEvent(tx, proposalId);
    if (decision) {
      if (decision.decision !== 'accept') {
        throw new ApiError(
          'conflict',
          `proposal ${proposalId} already decided as ${decision.decision}`,
          409,
        );
      }
      // A racing accept on the same proposal already committed.
      return decision;
    }
    const correction = await getCorrectionStatus(tx, proposalId);
    if (correction.state !== 'active') {
      throw new ApiError(
        'conflict',
        `proposal ${proposalId} is ${correction.state} and cannot be accepted`,
        409,
      );
    }

    // global learning-state write lock before any row access (shared
    // tx-entry order with every material_fsrs_state / mastery_state writer and
    // the cascade revert). Ordered BEFORE the question row lock: the other
    // draft→active promoters (quiz_verify / verify_and_promote) hold this lock
    // while UPDATEing question rows, so taking the row lock first could
    // deadlock against them.
    await acquireLearningStateWriteLock(tx);
    // Placement-supply scope locks are keyed on the draft's knowledge ids. The
    // pre-read is safe: a pending draft's knowledge_ids have no concurrent
    // writer (promotion is the only mutation path, and it is this tx).
    const scopeKnowledgeIds = ((
      await tx
        .select({ knowledge_ids: question.knowledge_ids })
        .from(question)
        .where(eq(question.id, questionId))
        .limit(1)
    )[0]?.knowledge_ids ?? []) as string[];
    await lockPlacementSupplyScopes(tx, scopeKnowledgeIds);

    // Lock the draft row FOR UPDATE: serializes against a dismiss of a SIBLING
    // question_draft proposal targeting the same draft — per-proposal decision
    // locks do not cover that (the tombstone UPDATE takes this row lock).
    const row = (
      await tx.select().from(question).where(eq(question.id, questionId)).for('update').limit(1)
    )[0];
    if (!row) {
      throw new ApiError('not_found', `question ${questionId} not found`, 404);
    }
    // NOT isPoolVisible — fail-closed promote guard (not-a-draft → reject/skip); do not fold into notDraftPredicate.
    if (row.draft_status !== LEGACY_DRAFT_STATUS.DRAFT) {
      throw new ApiError(
        'conflict',
        `question ${questionId} is in draft_status ${row.draft_status ?? 'null'}, expected 'draft'`,
        409,
      );
    }
    // Tombstone gate a sibling proposal's dismiss already retired
    // this draft. Promoting it would produce an active, FSRS-enrolled question
    // that the dismissed_at read filters still hide. Fail closed — there is no
    // un-dismiss path; author a fresh draft instead of resurrecting a
    // user-rejected one.
    const meta = row.metadata as { dismissed_at?: unknown; archived_at?: unknown } | null;
    if (meta?.dismissed_at != null || meta?.archived_at != null) {
      throw new ApiError(
        'conflict',
        `question ${questionId} is tombstoned (${meta.dismissed_at != null ? 'dismissed' : 'archived'}); a rejected draft cannot be promoted`,
        409,
      );
    }

    await tx
      .update(question)
      .set({ draft_status: LEGACY_DRAFT_STATUS.ACTIVE, updated_at: now })
      .where(eq(question.id, questionId));

    // Unified publish chain (question_draft rows): accept enters the unified publish flow.
    // draft 内容为 author/quiz 链生成，用户接受 ⇒ D9 手动带 provenance（manual ≠
    // official，D1）；接受人即人工核验门。同内容已发布过（如 sourced 草稿首版
    // withheld）时只翻 admission 维度，不铸新 revision。
    await publishQuestionGroupFromRow(tx, {
      rootId: row.parent_question_id ?? questionId,
      admission: {
        state: 'admitted',
        evidence: {
          marking_provenance: MARKING_RULE_PROVENANCE.MANUAL,
          verification: {
            structural_check_passed: true,
            independent_verification: {
              passed: true,
              verifier: 'human',
              verified_at: now.toISOString(),
            },
          },
          model_slice: null,
        },
      },
      // 人工接受 ⇒ 同版复核通过：清 verify_hold 恢复准入。
      suspension: { suspended: false },
      verification: {
        policy_id: 'proposal_accept@1',
        outcome: 'passed',
        evidence: { verifier: 'human', proposal_kind: 'question_draft' },
      },
      availability: QUESTION_AVAILABILITY.GENERAL_POOL,
      actorRef: 'proposal-accept:question_draft',
      now,
    });

    await enrollPromotedQuestionScheduling(tx, {
      questionId,
      knowledgeIds: row.knowledge_ids ?? [],
      evidenceEventId: rateEventId,
      now,
    });

    await writeEvent(tx, {
      id: rateEventId,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'rate',
      subject_kind: 'event',
      subject_id: proposalId,
      outcome: 'success',
      payload: {
        rating: 'accept',
        ...(opts.user_note ? { user_note: opts.user_note } : {}),
        materialized_question_id: questionId,
      },
      caused_by_event_id: proposalId,
      created_at: now,
    });
    return null;
  });

  if (concurrentDecision) {
    // A racing accept on this proposal committed first — idempotent replay.
    await ensureProposalDecisionSignal(db, proposal, 'accept', opts.user_note);
    await loadPromotedRowOrThrow(db);
    return {
      kind: 'question_draft',
      rate_event_id: concurrentDecision.id,
      question_id: questionId,
      idempotent: true,
    };
  }

  await recordProposalDecisionSignal(db, proposal, 'accept', opts.user_note);

  return { kind: 'question_draft', rate_event_id: rateEventId, question_id: questionId };
}

export interface QuestionDraftDismissResult {
  kind: 'dismissed';
  rate_event_id: string | null;
  idempotent?: boolean;
}

/**
 * question_draft dismiss applier (previously the phase-deferred gap:
 * the generic dismiss path left the draft row indistinguishable from a live
 * pending one, so search_bank's draft_state=all default and
 * write_quiz's draft admission kept re-surfacing a question the user already
 * rejected).
 *
 * One transaction: proposal decision lock → rate(dismiss) event → tombstone
 * the still-draft question row via `metadata.dismissed_at` (+ reason +
 * dismissed_proposal_id provenance) → decision signal. Mirrors the agency
 * lifecycle's all-in-tx shape (proposal-lifecycle.ts).
 *
 * The tombstone is a metadata marker, NOT a new draft_status literal: every
 * pool read filters `draft_status IS NULL OR <> 'draft'` (fail-open,
 * 红线-4/NULL≡active), so a 'dismissed' value would be treated as pool-visible
 * and leak the rejected question into due/stream/placement reads
 * (src/capabilities/practice/server/question-bank-write.ts header — the archive path made the same
 * call with metadata.archived_at). `draft_status='draft'` +
 * `metadata.dismissed_at` keeps the row invisible everywhere drafts are
 * excluded, while the marker lets draft-aware surfaces (search_bank,
 * listQuestions, listDraftReview, write_quiz, the matcher's lazy-verify) tell
 * "rejected" apart from "awaiting review".
 *
 * The UPDATE is conditioned on draft_status='draft': a row already promoted
 * (or otherwise moved on) is left untouched — the rate event still records
 * the dismissal.
 */
export async function dismissQuestionDraftProposal(
  db: Db,
  proposalId: string,
  proposal: ProposalInboxRow,
  opts: { user_note?: string },
): Promise<QuestionDraftDismissResult> {
  const change = asPlainRecord(proposal.payload.proposed_change);
  const questionId = requiredString(change.question_id, 'question_id', proposalId);

  const rate = await db.transaction(async (tx) => {
    // Serialize with a racing accept/dismiss on the same proposal (the accept
    // applier takes the same lock); writeProposalRateEvent then rejects a
    // cross-decision conflict with 409 and replays a same-decision one
    // idempotently.
    await acquireProposalDecisionLock(tx, proposalId);
    const rate = await writeProposalRateEvent(tx, proposalId, 'dismiss', opts.user_note);
    if (rate.idempotent) return rate;
    const now = new Date();
    await tx
      .update(question)
      .set({
        // archived_at 同款秒级 epoch 惯例 (archiveQuestion, question-bank-write.ts).
        metadata: sql`COALESCE(${question.metadata}, '{}'::jsonb) || ${JSON.stringify({
          dismissed_at: Math.floor(now.getTime() / 1000),
          dismissed_reason: 'question_draft_dismissed',
          dismissed_proposal_id: proposalId,
        })}::jsonb`,
        updated_at: now,
      })
      .where(
        and(eq(question.id, questionId), eq(question.draft_status, LEGACY_DRAFT_STATUS.DRAFT)),
      );
    return rate;
  });

  // Mirror variantQuestionProposalDismissApplier: signal bookkeeping lives
  // OUTSIDE the tx (its own signal lock) and runs only on the non-idempotent
  // path — the UPSERT increments dismiss_count, so an idempotent replay must
  // not double-count.
  if (!rate.idempotent) {
    await recordProposalDecisionSignal(db, proposal, 'dismiss', opts.user_note);
  }

  return {
    kind: 'dismissed',
    rate_event_id: rate.rate_event_id,
    ...(rate.idempotent ? { idempotent: true } : {}),
  };
}

// ===========================================================================
// D6-B — active-question structured node edit.
// This is the FIRST writer that mutates an ACTIVE question's `structured` jsonb
// tree. The question-bank writer (question-bank-write.ts editQuestion) also
// accepts structured replacements; its REST PATCH surface only exposes flat fields.
// The draft-layer structured editor
// (capabilities/ingestion block-structured-edit) only touches DRAFT
// question_block rows. The active-question structured write is owned HERE
// (practice domain owns the pooled question lifecycle), kept self-contained so
// the practice applier does not import the ingestion package (import-cycle
// hygiene + single domain ownership).
// Coordinate parity: nodes are addressed by `id` — the same id/role the L5
// addressable projection exposes through get_question_context(include:
// ['structure']). So the agent reads a node id and writes the same node id
// (read≡write).
// ===========================================================================

/**
 * D6-B — question_edit accept. Applies the narrow
 * node op to an ACTIVE question's `structured` tree behind the mini verify gate
 * (applyQuestionEdit), bumps the row version, and writes BOTH an
 * `experimental:question_structure_edit` audit event (before/after node snapshot
 * the reversible record) AND the `rate` accept event, all in one transaction.
 *
 * Idempotency keys on caused_by_event_id = proposalId (existingAcceptRate), like
 * every sibling accept handler: a re-accept returns the prior result without a
 * second mutation or audit event.
 *
 * Gate / not-found policy:
 * - missing question row → 404;
 * - question not active (draft_status='draft' / other) → 409 (this tool edits
 * POOLED questions only; draft structure is the ingestion block-edit path);
 * - question has no structured tree → 422 (nothing to address);
 * - verify-gate failure (node missing / wrong shape / would break invariants)
 * → 422 with the typed reason; the proposal stays pending so the user can
 * retract or the agent can re-propose a corrected op.
 */
export async function acceptQuestionEditProposal(
  db: Db,
  proposalId: string,
  proposal: ProposalInboxRow,
  opts: PracticeApplierOpts,
): Promise<QuestionEditAcceptResult> {
  ensureAcceptOnly('question_edit', opts);
  const change = asPlainRecord(proposal.payload.proposed_change);
  // 统一契约提案：proposed_change.edit_request（ops/document/draft_ref
  // + CAS 令牌）。accept = 重放 ops → draft → 同一 submit gate；legacy 提案
  // （proposed_change.edit 窄节点 op）仍走旧路径直到存量清空。
  if (change.edit_request != null) {
    return acceptUnifiedQuestionEditRequest(db, proposalId, change, proposal, opts);
  }
  const questionId = requiredString(change.question_id, 'question_id', proposalId);
  const edit = change.edit as QuestionEditOpT | undefined;
  if (!edit || typeof edit !== 'object' || typeof (edit as { op?: unknown }).op !== 'string') {
    throw new ApiError(
      'validation_error',
      `proposal ${proposalId} is missing required proposed_change.edit`,
      400,
    );
  }

  const actorRef = proposal.actor_ref ?? 'agent:copilot';

  // Already-accepted idempotency: a rate event exists (409s on a non-accept
  // decision inside existingAcceptRate).
  const existingRate = await existingAcceptRate(db, proposalId);
  if (existingRate) {
    await ensureProposalDecisionSignal(db, proposal, 'accept', opts.user_note);
    const existing = await loadAcceptedQuestionOrThrow(db, proposalId, questionId);
    return {
      kind: 'question_edit',
      rate_event_id: existingRate.id,
      question_id: questionId,
      edit_event_id: null,
      version: existing.version,
      idempotent: true,
    };
  }

  const row = (await db.select().from(question).where(eq(question.id, questionId)).limit(1))[0];
  if (!row) {
    throw new ApiError('not_found', `question ${questionId} not found`, 404);
  }
  if (row.draft_status !== LEGACY_DRAFT_STATUS.ACTIVE) {
    // Editing the structured tree of a pooled question only. A draft question's
    // structure is the ingestion block-edit path (draft layer); a re-drafted /
    // archived row is not an edit target.
    throw new ApiError(
      'conflict',
      `question ${questionId} is draft_status ${row.draft_status ?? 'null'}, expected 'active'`,
      409,
    );
  }
  if (!row.structured) {
    throw new ApiError(
      'unprocessable_entity',
      `question ${questionId} has no structured tree to edit`,
      422,
    );
  }

  const applied = applyQuestionEdit(row.structured, edit, actorRef);
  if ('failure' in applied) {
    throw new ApiError(
      'unprocessable_entity',
      `question_edit verify gate rejected the edit (${applied.failure}) for question ${questionId}`,
      422,
    );
  }

  const now = new Date();
  const rateEventId = newId();
  const editEventId = newId();
  const nextVersion = row.version + 1;

  const concurrentAcceptRate = await db.transaction(async (tx) => {
    await acquireProposalDecisionLock(tx, proposalId);
    const decision = await findExistingRateEvent(tx, proposalId);
    if (decision) {
      if (decision.decision !== 'accept') {
        throw new ApiError(
          'conflict',
          `proposal ${proposalId} already decided as ${decision.decision}`,
          409,
        );
      }
      return decision;
    }
    const correction = await getCorrectionStatus(tx, proposalId);
    if (correction.state !== 'active') {
      throw new ApiError(
        'conflict',
        `proposal ${proposalId} is ${correction.state} and cannot be accepted`,
        409,
      );
    }

    // Optimistic write guarded by the version we read; a concurrent structured
    // edit bumps the version and this update matches 0 rows → conflict.
    const updated = await tx
      .update(question)
      .set({ structured: applied.tree, updated_at: now, version: nextVersion })
      .where(and(eq(question.id, questionId), eq(question.version, row.version)))
      .returning({ version: question.version });
    if (updated.length === 0) {
      throw new ApiError(
        'conflict',
        `question ${questionId} was modified concurrently; retry`,
        409,
      );
    }

    // Unified publish chain (structured-edit rows): the structured tree is grading input, so
    // the edit enters the same publish flow.
    // （part/slot/option 身份来源），接受 ⇒ 同事务铸新 revision；node id 语义
    // 不变则身份保留（applyQuestionEdit 保留 node id），替换则新身份。
    // admission 缺省 preserve —— 内容编辑不改变准入资格。
    await publishQuestionGroupFromRow(tx, {
      rootId: row.parent_question_id ?? questionId,
      actorRef: `proposal-accept:question_edit:${actorRef}`,
      now,
    });

    // Reversible audit trail (before/after node snapshot) — the structured edit
    // is correctable from this event without trusting the proposal payload.
    await writeEvent(tx, {
      id: editEventId,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'experimental:question_structure_edit',
      subject_kind: 'question',
      subject_id: questionId,
      outcome: 'success',
      payload: {
        question_id: questionId,
        proposal_event_id: proposalId,
        op: edit.op,
        node_id: edit.node_id,
        previous_version: row.version,
        next_version: nextVersion,
        before: applied.before,
        after: applied.after,
      },
      caused_by_event_id: proposalId,
      created_at: now,
    });

    await writeEvent(tx, {
      id: rateEventId,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'rate',
      subject_kind: 'event',
      subject_id: proposalId,
      outcome: 'success',
      payload: {
        rating: 'accept',
        ...(opts.user_note ? { user_note: opts.user_note } : {}),
        materialized_question_id: questionId,
        structure_edit_event_id: editEventId,
      },
      caused_by_event_id: proposalId,
      created_at: now,
    });

    return null;
  });

  if (concurrentAcceptRate) {
    await ensureProposalDecisionSignal(db, proposal, 'accept', opts.user_note);
    const existing = await loadAcceptedQuestionOrThrow(db, proposalId, questionId);
    return {
      kind: 'question_edit',
      rate_event_id: concurrentAcceptRate.id,
      question_id: questionId,
      edit_event_id: null,
      version: existing.version,
      idempotent: true,
    };
  }

  await recordProposalDecisionSignal(db, proposal, 'accept', opts.user_note);

  return {
    kind: 'question_edit',
    rate_event_id: rateEventId,
    question_id: questionId,
    edit_event_id: editEventId,
    version: nextVersion,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//B — cause_category accept：往 cause_category_overlay INSERT
// status='active' 行。这是该表的唯一写边界（audit:schema 的 write path）；行
// 落地后进入 attribution 合并词表（listActiveCauseCategoryOverlays）。
export interface CauseCategoryAcceptResult {
  kind: 'cause_category';
  rate_event_id: string | null;
  category_id: string;
  idempotent?: boolean;
}

export async function acceptCauseCategoryProposal(
  db: Db,
  proposalId: string,
  proposal: ProposalInboxRow,
  opts: PracticeApplierOpts,
): Promise<CauseCategoryAcceptResult> {
  ensureAcceptOnly('cause_category', opts);
  const change = asPlainRecord(proposal.payload.proposed_change);
  const categoryId = requiredString(change.category_id, 'category_id', proposalId);
  const label = requiredString(change.label, 'label', proposalId);
  // 防绕过：生产者契约是 ov_ 命名空间；applier 也守住——非 ov_ id 会在合并词表
  // 里与 profile 声明撞名。裸前缀（空 slug）同样显式拒绝（收紧）。
  if (!categoryId.startsWith(CAUSE_OVERLAY_ID_PREFIX)) {
    throw new ApiError(
      'validation_error',
      `proposal ${proposalId} category_id ${categoryId} must use the ${CAUSE_OVERLAY_ID_PREFIX} namespace`,
      400,
    );
  }
  if (categoryId === CAUSE_OVERLAY_ID_PREFIX) {
    throw new ApiError(
      'validation_error',
      `proposal ${proposalId} category_id is the bare '${CAUSE_OVERLAY_ID_PREFIX}' prefix — empty slug`,
      400,
    );
  }
  const description =
    typeof change.description === 'string' && change.description.trim().length > 0
      ? change.description.trim()
      : null;
  const source = change.source === 'owner' ? 'owner' : 'llm_propose';
  const subjectId = proposal.payload.target.subject_id;
  if (!subjectId) {
    throw new ApiError(
      'validation_error',
      `proposal ${proposalId} is missing target.subject_id (subject profile id)`,
      400,
    );
  }
  const evidenceEventIds = (proposal.payload.evidence_refs ?? [])
    .filter((ref) => ref.kind === 'event')
    .map((ref) => ref.id);

  const loadRowOrThrow = async (dbLike: Db | Tx) => {
    const existing = (
      await dbLike
        .select()
        .from(cause_category_overlay)
        .where(eq(cause_category_overlay.id, categoryId))
        .limit(1)
    )[0];
    if (!existing || existing.archived_at !== null || existing.status !== 'active') {
      throw new ApiError(
        'inconsistent_state',
        `proposal ${proposalId} has an accept rate event but overlay row ${categoryId} is ${
          existing ? 'not active' : 'missing'
        }; retract + retry`,
        500,
      );
    }
    return existing;
  };

  // Already-accepted idempotency fast path（question_draft 同款形状）。
  const existingRate = await existingAcceptRate(db, proposalId);
  if (existingRate) {
    await ensureProposalDecisionSignal(db, proposal, 'accept', opts.user_note);
    await loadRowOrThrow(db);
    return {
      kind: 'cause_category',
      rate_event_id: existingRate.id,
      category_id: categoryId,
      idempotent: true,
    };
  }

  const now = new Date();
  let writtenRateEventId: string | null = null;
  const concurrentDecision = await db.transaction(async (tx) => {
    await acquireProposalDecisionLock(tx, proposalId);
    const decision = await findExistingRateEvent(tx, proposalId);
    if (decision) {
      if (decision.decision !== 'accept') {
        throw new ApiError(
          'conflict',
          `proposal ${proposalId} already decided as ${decision.decision}`,
          409,
        );
      }
      return decision;
    }
    const correction = await getCorrectionStatus(tx, proposalId);
    if (correction.state !== 'active') {
      throw new ApiError(
        'conflict',
        `proposal ${proposalId} is ${correction.state} and cannot be accepted`,
        409,
      );
    }

    // id 防撞：行已存在 = 另一个 proposal/路径已占用该 id。一律 409——归档行
    // 复活是另一个语义决定，v1 不做（owner 可换 slug 或人工恢复）。
    const existing = (
      await tx
        .select({ id: cause_category_overlay.id })
        .from(cause_category_overlay)
        .where(eq(cause_category_overlay.id, categoryId))
        .limit(1)
    )[0];
    if (existing) {
      throw new ApiError(
        'conflict',
        `cause_category_overlay ${categoryId} already exists; choose a different slug`,
        409,
      );
    }

    // 竞态收口：decision lock 按 proposalId 取，不同 proposal 撞同一
    // categoryId 时两个 tx 可同过上方 SELECT。onConflictDoNothing 让并发 INSERT
    // 优雅落空（阻塞至对方提交后再判），空 returning = 撞上 → 同一个 409。
    const inserted = await tx
      .insert(cause_category_overlay)
      .values({
        id: categoryId,
        subject_id: subjectId,
        label,
        description,
        source,
        status: 'active',
        proposal_event_id: proposalId,
        evidence_event_ids: evidenceEventIds,
        created_at: now,
        updated_at: now,
      })
      .onConflictDoNothing({ target: cause_category_overlay.id })
      .returning({ id: cause_category_overlay.id });
    if (inserted.length === 0) {
      throw new ApiError(
        'conflict',
        `cause_category_overlay ${categoryId} already exists; choose a different slug`,
        409,
      );
    }

    const rate = await writeProposalRateEvent(tx, proposalId, 'accept', opts.user_note);
    writtenRateEventId = rate.rate_event_id;
    return null;
  });

  if (concurrentDecision) {
    await ensureProposalDecisionSignal(db, proposal, 'accept', opts.user_note);
    await loadRowOrThrow(db);
    return {
      kind: 'cause_category',
      rate_event_id: concurrentDecision.id,
      category_id: categoryId,
      idempotent: true,
    };
  }

  await recordProposalDecisionSignal(db, proposal, 'accept', opts.user_note);
  return {
    kind: 'cause_category',
    rate_event_id: writtenRateEventId,
    category_id: categoryId,
  };
}

// =============================================================================
// 统一 edit_question 契约提案 accept（edit_request 形状）
// =============================================================================
// Copilot 的 edit_question(save) 落 proposed_change.edit_request =
// {question_id, ops?, document?, draft_ref?, expected_revision?,
// expected_draft_version?}。accept = 经同一 ops → draft → submit gate：
// 1. saveDraftEdit（request_id = proposal-accept:<id> —— 重放幂等）；
// 2. submitDraftQuestion（同 request_id —— CAS/去重/publish 唯一 seam）；
// 3. rate(accept) 事件 + proposal decision 信号（与旧路径同生命周期）。
// CAS 冲突（revision 已动 / draft 版本已动）⇒ 409，proposal 保留 pending。

interface UnifiedEditRequest {
  question_id?: string | null;
  ops?: unknown[];
  document?: unknown;
  draft_ref?: string;
  expected_revision?: string | null;
  expected_draft_version?: number;
}

async function acceptUnifiedQuestionEditRequest(
  db: Db,
  proposalId: string,
  change: Record<string, unknown>,
  proposal: ProposalInboxRow,
  opts: PracticeApplierOpts,
): Promise<QuestionEditAcceptResult> {
  const editRequest = change.edit_request as UnifiedEditRequest;
  const questionId = (editRequest.question_id ?? change.question_id ?? null) as string | null;
  const actorRef = proposal.actor_ref ?? 'agent:copilot';

  const existingRate = await existingAcceptRate(db, proposalId);
  if (existingRate) {
    await ensureProposalDecisionSignal(db, proposal, 'accept', opts.user_note);
    if (questionId != null) await loadAcceptedQuestionOrThrow(db, proposalId, questionId);
    return {
      kind: 'question_edit',
      rate_event_id: existingRate.id,
      question_id: questionId ?? 'draft',
      edit_event_id: null,
      version: 0,
      idempotent: true,
    };
  }

  // 并发决策锁（与旧路径同机制）——先锁再执行编辑+提交。
  const concurrentDecision = await db.transaction(async (tx) => {
    await acquireProposalDecisionLock(tx, proposalId);
    const decision = await findExistingRateEvent(tx, proposalId);
    if (decision) {
      if (decision.decision !== 'accept') {
        throw new ApiError(
          'conflict',
          `proposal ${proposalId} already decided as ${decision.decision}`,
          409,
        );
      }
      return decision;
    }
    const correction = await getCorrectionStatus(tx, proposalId);
    if (correction.state !== 'active') {
      throw new ApiError(
        'conflict',
        `proposal ${proposalId} is ${correction.state} and cannot be accepted`,
        409,
      );
    }
    return null;
  });
  if (concurrentDecision) {
    await ensureProposalDecisionSignal(db, proposal, 'accept', opts.user_note);
    if (questionId != null) await loadAcceptedQuestionOrThrow(db, proposalId, questionId);
    return {
      kind: 'question_edit',
      rate_event_id: concurrentDecision.id,
      question_id: questionId ?? 'draft',
      edit_event_id: null,
      version: 0,
      idempotent: true,
    };
  }

  const { saveDraftEdit, EditQuestionInput } = await import('./tools/submit-question');
  const { submitDraftQuestion } = await import('./tools/submit-question');
  const now = new Date();
  const saveRequestId = `proposal-accept:${proposalId}`;
  const parsedSave = EditQuestionInput.safeParse({
    action: 'save',
    ...(editRequest.ops != null ? { ops: editRequest.ops } : {}),
    ...(editRequest.document !== undefined ? { document: editRequest.document } : {}),
    ...(editRequest.draft_ref != null ? { draft_ref: editRequest.draft_ref } : {}),
    ...(questionId != null ? { question_id: questionId } : {}),
    ...(editRequest.expected_revision !== undefined
      ? { expected_revision: editRequest.expected_revision }
      : {}),
    ...(editRequest.expected_draft_version !== undefined
      ? { expected_draft_version: editRequest.expected_draft_version }
      : {}),
    request_id: saveRequestId,
  });
  if (!parsedSave.success) {
    throw new ApiError(
      'validation_error',
      `proposal ${proposalId} edit_request failed edit_question input validation: ${parsedSave.error.message}`,
      400,
    );
  }
  const [source] = await db
    .select({
      id: event.id,
      sessionId: event.session_id,
      taskRunId: event.task_run_id,
    })
    .from(event)
    .where(
      and(
        eq(event.id, proposalId),
        eq(event.action, 'experimental:proposal'),
        eq(event.actor_ref, proposal.actor_ref),
      ),
    );
  const serviceCtx = {
    actorRef,
    actorKind: 'user' as const,
    sessionId: source?.sessionId ?? null,
    taskRunId: source?.taskRunId ?? undefined,
    causedByEventId: source?.id ?? null,
  };
  const saved = await saveDraftEdit(db, { input: parsedSave.data, ctx: serviceCtx });
  if (saved.status === 'conflict') {
    throw new ApiError(
      'conflict',
      `edit_question save conflict (${saved.reason}): ${saved.detail}`,
      409,
    );
  }
  if (saved.status === 'rejected') {
    throw new ApiError(
      'unprocessable_entity',
      `edit_question ops rejected: ${saved.issues.map((i) => i.detail).join('; ')}`,
      422,
    );
  }
  if (saved.status !== 'saved' && saved.status !== 'noop') {
    throw new ApiError('inconsistent_state', `unexpected save status '${saved.status}'`, 500);
  }

  // 提交经同一 gate（唯一 publisher seam）；noop 保存且目标为已发布题时也走
  // submit（草稿可能携带此前未提交的累积编辑）。
  const submitted = await submitDraftQuestion(
    db,
    {
      draft_ref: saved.draft_ref,
      expected_draft_version: saved.draft_version,
      ...(editRequest.expected_revision !== undefined
        ? { expected_revision: editRequest.expected_revision }
        : {}),
      request_id: `proposal-submit:${proposalId}`,
    },
    serviceCtx,
  );
  if (submitted.status === 'conflict') {
    throw new ApiError(
      'conflict',
      `submit_question conflict (${submitted.reason}): ${submitted.detail}`,
      409,
    );
  }
  // 未发布的 withheld（conversion 未决 / 死 KC / 组级 blocker）= accept 失败：
  // 不落 structure-edit/accept 事件，如实返回原因。「已发布但 admission
  // withheld/pending（verify 在途）」不同 —— revision 已铸，照常落事件。
  if (
    submitted.status === 'withheld' &&
    'published' in submitted &&
    submitted.published === false
  ) {
    throw new ApiError(
      'unprocessable_entity',
      `submit_question withheld (not published): ${submitted.detail}`,
      422,
    );
  }
  const resolvedQuestionId = 'question_id' in submitted ? submitted.question_id : questionId;
  const nowRow =
    resolvedQuestionId != null
      ? (await db.select().from(question).where(eq(question.id, resolvedQuestionId)).limit(1))[0]
      : undefined;
  const nextVersion = nowRow?.version ?? 0;

  const editEventId = newId();
  const rateEventId = newId();
  await db.transaction(async (tx) => {
    await writeEvent(tx, {
      id: editEventId,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'experimental:question_structure_edit',
      subject_kind: 'question',
      subject_id: resolvedQuestionId ?? 'draft',
      outcome: 'success',
      payload: {
        question_id: resolvedQuestionId,
        proposal_event_id: proposalId,
        op: 'edit_request',
        draft_ref: saved.draft_ref,
        submit_status: submitted.status,
        revision_id: 'revision_id' in submitted ? submitted.revision_id : undefined,
      },
      caused_by_event_id: proposalId,
      created_at: now,
    });
    await writeEvent(tx, {
      id: rateEventId,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'rate',
      subject_kind: 'event',
      subject_id: proposalId,
      outcome: 'success',
      payload: {
        rating: 'accept',
        ...(opts.user_note ? { user_note: opts.user_note } : {}),
        materialized_question_id: resolvedQuestionId,
        structure_edit_event_id: editEventId,
      },
      caused_by_event_id: proposalId,
      created_at: now,
    });
  });

  await recordProposalDecisionSignal(db, proposal, 'accept', opts.user_note);
  return {
    kind: 'question_edit',
    rate_event_id: rateEventId,
    question_id: resolvedQuestionId ?? 'draft',
    edit_event_id: editEventId,
    version: nextVersion,
  };
}

// ====================================================================
// judge_retraction accept applier（判分纠错提案的真身）
// ====================================================================
// 两类目标：
// - subject_kind='evaluation'（native 评价行）：按 proposed_change.correction_kind
// · rejudge → 写 experimental:appeal_request（expected head = 提案创建时
// 冻结的快照，允许非 effective 目标）→ rejudge job → 冻结输入重评 →
// CAS 激活 → settlement replay 自动回算 FSRS/θ/掌握度；
// · assert → 按 asserted_verdicts 产出 manual_assert candidate 并同步
// 激活 + 写 appeal resolution 事件。
// - subject_kind='event'（legacy judge event）：写 CorrectEvent(retract)，
// 命中既有 event 纠偏投影（corrections.ts）。
// 任何路径都不回写原评价/FSRS/掌握度 —— 全部走"新事件 + 新 candidate +
// 激活 + replay"的既有可逆机制。

export interface JudgeRetractionAcceptResult {
  kind: 'judge_retraction';
  rate_event_id: string | null;
  /** evaluation 目标：appeal_request/纠错锚点事件 id。 */
  correction_event_id?: string;
  /** assert 路径：新激活的 candidate evaluation id。 */
  corrected_evaluation_id?: string;
  /** rejudge → 'queued_rejudge'；assert → 激活态；event → 'retracted'。 */
  disposition: string;
  idempotent?: boolean;
}

export type EnqueueRejudgeFn = (appealEventId: string) => Promise<void>;

async function defaultEnqueueRejudge(appealEventId: string): Promise<void> {
  const { getPracticeBoss } = await import('./queue-runtime');
  const { REJUDGE_SINGLETON_SECONDS } = await import('../jobs/rejudge-config');
  const boss = await getPracticeBoss();
  await boss.send(
    'rejudge',
    { appeal_event_id: appealEventId },
    { singletonKey: appealEventId, singletonSeconds: REJUDGE_SINGLETON_SECONDS },
  );
}

async function findProposalCorrectionEvent(db: Db, proposalId: string) {
  const [row] = await db
    .select({ id: event.id })
    .from(event)
    .where(
      and(
        eq(event.action, 'experimental:appeal_request'),
        eq(event.caused_by_event_id, proposalId),
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

async function writeCorrectionResolution(
  db: Db | Tx,
  input: {
    correctionEventId: string;
    evaluationSubjectId: string;
    disposition: string;
    evaluationId?: string;
  },
) {
  const id = `evt_eval_correction_resolution_${canonicalHash(input.correctionEventId)}`;
  const [existing] = await db.select({ id: event.id }).from(event).where(eq(event.id, id)).limit(1);
  if (existing) return;
  await writeEvent(db, {
    id,
    actor_kind: 'system',
    actor_ref: 'assessment:correction',
    action: 'experimental:assessment_appeal_resolution',
    subject_kind: 'evaluation',
    subject_id: input.evaluationSubjectId,
    outcome: null,
    caused_by_event_id: input.correctionEventId,
    payload: {
      disposition: input.disposition,
      ...(input.evaluationId ? { evaluation_id: input.evaluationId } : {}),
    },
  });
}

// applyManualAssertCorrection 的确定性校验失败：写一条 failed:<code> resolution，
// 但绝不落 accept —— 提案保持 pending，owner 可重试/驳回，而不是显示成已采纳却零效果。
const permanentAssertFailureCodes: ReadonlySet<string> = new Set([
  'not_correctable',
  'frozen_input_unavailable',
  'not_found',
  'assert_coverage_incomplete',
  'assert_unit_not_additive',
  'assert_unit_unknown',
  'evaluation_key_conflict',
]);

function permanentAssertFailureDisposition(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const code =
    error instanceof ApiError
      ? error.code
      : error.name === 'EvaluateSubmissionError'
        ? (error as Error & { code?: string }).code
        : undefined;
  return code && permanentAssertFailureCodes.has(code) ? `failed:${code}` : null;
}

/** assert 路径：人工判定 → manual_assert candidate → CAS 激活 + resolution 事件。 */
async function applyManualAssertCorrection(
  db: Db,
  input: {
    proposalId: string;
    evaluationId: string;
    correctionEventId: string;
    reasonMd: string;
    assertedVerdicts: { scoring_unit_id: string; verdict: 'correct' | 'incorrect' }[];
    /** proposal 创建时冻结的 head 期望（P1 review）——CAS 按此比对，不现读。 */
    expectedHead: { effectiveEvaluationId: string | null; generation: number };
  },
): Promise<{ correctedEvaluationId: string; disposition: string }> {
  const { evaluateAttempt } = await import('./judge/evaluation-authority');
  const { activateSubmissionCandidate } = await import('./judge/evaluate-submission');

  const [original] = await db
    .select()
    .from(evaluation)
    .where(eq(evaluation.evaluation_id, input.evaluationId))
    .limit(1);
  if (original?.status !== 'completed') {
    throw new ApiError('not_correctable', 'target evaluation missing or not completed', 409);
  }
  const provenance = EvaluationProvenance.safeParse(original.provenance);
  if (!provenance.success || !provenance.data.input_snapshot) {
    throw new ApiError(
      'frozen_input_unavailable',
      'assert correction requires the frozen input snapshot',
      409,
    );
  }
  const [revisionRow] = await db
    .select()
    .from(question_revision)
    .where(eq(question_revision.revision_id, provenance.data.input_snapshot.revision_id))
    .limit(1);
  if (!revisionRow) {
    throw new ApiError('not_found', 'frozen revision row missing for assert correction', 409);
  }
  const revision = PublishedQuestionRevision.parse({
    revision_id: revisionRow.revision_id,
    group_id: revisionRow.group_id,
    revision_ordinal: revisionRow.revision_ordinal,
    integrity_digest: revisionRow.integrity_digest,
    structure: revisionRow.structure,
    response_spec: revisionRow.response_spec,
    scoring_basis: revisionRow.scoring_basis,
    execution_plan: revisionRow.execution_plan,
    published_at:
      typeof revisionRow.published_at === 'string'
        ? revisionRow.published_at
        : revisionRow.published_at.toISOString(),
    supersedes_revision_id: revisionRow.supersedes_revision_id,
  });
  const scopedBasis = projectIssuedScoringBasis(
    revision,
    provenance.data.input_snapshot.issued_part_ids,
  );
  const verdicts = new Map(input.assertedVerdicts.map((v) => [v.scoring_unit_id, v.verdict]));
  // scopedBasis.units = 本次 issuance 发题范围内的全部 unit（assert 需全覆盖）。
  const scopedUnits = scopedBasis.units;
  const asserted: ScoringUnitResultT[] = scopedUnits.map((unit) => {
    const verdict = verdicts.get(unit.scoring_unit_id);
    if (verdict === undefined) {
      throw new ApiError(
        'assert_coverage_incomplete',
        `asserted_verdicts must cover every in-scope unit; missing '${unit.scoring_unit_id}'`,
        422,
      );
    }
    if (unit.points === null) {
      throw new ApiError(
        'assert_unit_not_additive',
        `unit '${unit.scoring_unit_id}' is not additive-scored — manual assert needs the holistic lane, which is not part of this correction path`,
        422,
      );
    }
    return {
      status: 'scored',
      scoring_unit_id: unit.scoring_unit_id,
      points_awarded: verdict === 'correct' ? unit.points : 0,
      scored_because: 'response',
      judged_by: 'human_review',
      feedback_md: input.reasonMd || undefined,
      evidence_citations: [],
    };
  });
  for (const v of input.assertedVerdicts) {
    if (!scopedUnits.some((unit) => unit.scoring_unit_id === v.scoring_unit_id)) {
      throw new ApiError(
        'assert_unit_unknown',
        `asserted_verdicts references unknown/out-of-scope unit '${v.scoring_unit_id}'`,
        422,
      );
    }
  }

  const candidate = await evaluateAttempt({
    db,
    entry: 'appeal_rejudge',
    contract: {
      submission_id: original.submission_id,
      evaluation_group_id: original.evaluation_group_id,
      expected_submission_ids: provenance.data.input_snapshot.member_submission_ids,
      evaluation_key: `correction:${input.proposalId}`,
      mode: 'manual_assert',
      asserted_unit_results: asserted,
      provenance: {
        source: 'manual',
        assisted: false,
        review_context: {
          appeal_event_id: input.correctionEventId,
          prior_evaluation_id: original.evaluation_id,
          reason_md: input.reasonMd,
        },
      },
    },
  });
  const candidateId = candidate.evaluation.record.evaluation_id;

  // P1 review — CAS 期望来自 proposal 冻结快照，不是 accept 时的现值：head
  // 已移动 ⇒ activation 返回 conflict，重放是非变异性的，绝不覆盖后到的 B。
  const intent = ActivateEvaluationIntent.parse({
    evaluation_id: candidateId,
    expected_effective_id: input.expectedHead.effectiveEvaluationId,
    expected_generation: input.expectedHead.generation,
  });
  let disposition: string;
  if (candidate.evaluation.record.status === 'completed') {
    const activation = await activateSubmissionCandidate(db, intent, {
      actorRef: 'assessment:correction',
      record: (tx) =>
        writeCorrectionResolution(tx, {
          correctionEventId: input.correctionEventId,
          evaluationSubjectId: original.evaluation_id,
          disposition: 'effective',
          evaluationId: candidateId,
        }),
    });
    disposition =
      activation.status === 'activated' || activation.status === 'already_effective'
        ? 'effective'
        : `held:${activation.status}`;
    if (disposition !== 'effective') {
      await writeCorrectionResolution(db, {
        correctionEventId: input.correctionEventId,
        evaluationSubjectId: original.evaluation_id,
        disposition,
        evaluationId: candidateId,
      });
    }
  } else {
    disposition = 'held:candidate_pending';
    await writeCorrectionResolution(db, {
      correctionEventId: input.correctionEventId,
      evaluationSubjectId: original.evaluation_id,
      disposition,
      evaluationId: candidateId,
    });
  }
  return { correctedEvaluationId: candidateId, disposition };
}

export async function acceptJudgeRetractionProposal(
  db: Db,
  proposalId: string,
  proposal: ProposalInboxRow,
  opts: PracticeApplierOpts,
): Promise<JudgeRetractionAcceptResult> {
  ensureAcceptOnly('judge_retraction', opts);
  const change = asPlainRecord(proposal.payload.proposed_change);
  const target = asPlainRecord(proposal.payload.target);
  const reasonMd =
    typeof change.reason_md === 'string'
      ? change.reason_md
      : typeof proposal.payload.reason_md === 'string'
        ? proposal.payload.reason_md
        : '';

  // ── native evaluation 目标：rejudge（异步）或 assert（同步人工判定激活）。
  if (target.subject_kind === 'evaluation') {
    const evaluationId = requiredString(change.evaluation_id, 'evaluation_id', proposalId);
    const correctionKind = change.correction_kind === 'assert' ? 'assert' : 'rejudge';
    // P1 review — 冻结的 head 期望必须随 proposal 落库（服务端观测，非 agent
    // 提供）。缺字段 ⇒ 无法证明观察时点，拒绝而不是悄悄按 accept 时的 head
    // 重订 —— 否则过期提案/重试会把后到的纠错 B 覆盖回 A。
    const expectedEffectiveId =
      change.expected_effective_id === null
        ? null
        : requiredString(change.expected_effective_id, 'expected_effective_id', proposalId);
    if (typeof change.expected_generation !== 'number' || change.expected_generation < 0) {
      throw new ApiError(
        'validation_error',
        `proposal ${proposalId} is missing required proposed_change.expected_generation`,
        400,
      );
    }
    const expectedGeneration = change.expected_generation;

    // assert payload 校验放在写 appeal request 之前：畸形提案不能留下无结论的
    // correction 事件。producer 已做同样的全覆盖校验，这里保留解析/兜底。
    let assertedVerdicts: { scoring_unit_id: string; verdict: 'correct' | 'incorrect' }[] = [];
    if (correctionKind === 'assert') {
      const rawVerdicts = Array.isArray(change.asserted_verdicts) ? change.asserted_verdicts : [];
      assertedVerdicts = rawVerdicts
        .map((v) => asPlainRecord(v))
        .map((v) => ({
          scoring_unit_id: typeof v.scoring_unit_id === 'string' ? v.scoring_unit_id : '',
          verdict: v.verdict === 'correct' ? ('correct' as const) : ('incorrect' as const),
        }));
      if (assertedVerdicts.length === 0 || assertedVerdicts.some((v) => v.scoring_unit_id === '')) {
        throw new ApiError(
          'validation_error',
          "correction_kind='assert' requires non-empty asserted_verdicts",
          400,
        );
      }
    }

    const existingRate = await existingAcceptRate(db, proposalId);
    const existingCorrection = await findProposalCorrectionEvent(db, proposalId);

    const { requestEvaluationCorrection } = await import('./assessment/appeal');
    const correctionEventId =
      existingCorrection ??
      (await requestEvaluationCorrection(db, {
        evaluation_id: evaluationId,
        reason_md: reasonMd,
        proposal_event_id: proposalId,
        expected_effective_id: expectedEffectiveId,
        expected_generation: expectedGeneration,
      }));

    if (correctionKind === 'rejudge') {
      // P1 review — durable correction event / accept rate 都不是投递证明：
      // crash/throw 可能把 job 留在未投态。任何路径都先补一遍 singleton
      // enqueue —— 60s 窗口内 send 返回 null 不产生 dup job；窗口外的
      // dup job 由 handler 的 appealAlreadyResolved + activation CAS 幂等
      // 兜底 —— 之后才判定 done。顺序：correction event → enqueue → rate。
      const enqueue = opts.enqueueRejudge ?? defaultEnqueueRejudge;
      await enqueue(correctionEventId);
      if (existingRate && existingCorrection) {
        return {
          kind: 'judge_retraction',
          rate_event_id: existingRate.id,
          correction_event_id: existingCorrection,
          disposition: 'already_applied',
          idempotent: true,
        };
      }
      const rate = existingRate
        ? { rate_event_id: existingRate.id, rate_at: existingRate.created_at }
        : await writeProposalRateEvent(db, proposalId, 'accept', opts.user_note);
      await recordProposalDecisionSignal(db, proposal, 'accept', opts.user_note);
      return {
        kind: 'judge_retraction',
        rate_event_id: rate.rate_event_id,
        correction_event_id: correctionEventId,
        disposition: 'queued_rejudge',
      };
    }

    // assert —— asserted_verdicts 已在上方解析校验，producer 也预校验过覆盖。
    // assert 幂等：manual_assert 的 evaluation_key（correction:<proposalId>）在
    // evaluateSubmission 里按 intent_digest 重放同一 candidate；activation CAS
    // 以 proposal 冻结期望比对 —— head 已动则 conflict（非变异性），命中已激
    // 活则 already_effective；resolution 事件按确定性 id 只写一次。
    let outcome: { correctedEvaluationId: string; disposition: string };
    try {
      outcome = await applyManualAssertCorrection(db, {
        proposalId,
        evaluationId,
        correctionEventId,
        reasonMd,
        assertedVerdicts,
        expectedHead: {
          effectiveEvaluationId: expectedEffectiveId,
          generation: expectedGeneration,
        },
      });
    } catch (error) {
      // accept rate 必须写在效果之后：确定性校验失败时提案保持 pending。
      // correction request 已提交，补终态 resolution，不让 appeal 无结论。
      const disposition = permanentAssertFailureDisposition(error);
      if (disposition) {
        await writeCorrectionResolution(db, {
          correctionEventId,
          evaluationSubjectId: evaluationId,
          disposition,
        });
      }
      throw error;
    }
    const rate = existingRate
      ? { rate_event_id: existingRate.id, rate_at: existingRate.created_at }
      : await writeProposalRateEvent(db, proposalId, 'accept', opts.user_note);
    await recordProposalDecisionSignal(db, proposal, 'accept', opts.user_note);
    return {
      kind: 'judge_retraction',
      rate_event_id: rate.rate_event_id,
      correction_event_id: correctionEventId,
      ...(outcome.correctedEvaluationId
        ? { corrected_evaluation_id: outcome.correctedEvaluationId }
        : {}),
      disposition: outcome.disposition,
    };
  }

  // ── legacy judge-event 目标：CorrectEvent(retract) → 既有纠偏投影。
  const judgeEventId = requiredString(change.judge_event_id, 'judge_event_id', proposalId);
  const [judgeEvent] = await db.select().from(event).where(eq(event.id, judgeEventId)).limit(1);
  if (judgeEvent?.action !== 'judge') {
    throw new ApiError(
      'evidence_ref_must_be_judge_event',
      'target event is not a judge event',
      422,
    );
  }
  const correctionEventId = `evt_event_correction_${canonicalHash({ proposal: proposalId, target: judgeEventId, kind: 'retract' })}`;
  await db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: event.id })
      .from(event)
      .where(eq(event.id, correctionEventId))
      .limit(1);
    if (existing.length === 0) {
      await writeEvent(tx, {
        id: correctionEventId,
        actor_kind: 'user',
        actor_ref: 'self',
        action: 'correct',
        subject_kind: 'event',
        subject_id: judgeEventId,
        outcome: 'success',
        payload: {
          correction_kind: 'retract',
          reason_md: reasonMd || 'judge_retraction proposal accepted',
          affected_refs: [{ kind: 'event', id: judgeEventId }],
        },
        caused_by_event_id: proposalId,
      });
    }
  });
  const rate = await writeProposalRateEvent(db, proposalId, 'accept', opts.user_note);
  await recordProposalDecisionSignal(db, proposal, 'accept', opts.user_note);
  return {
    kind: 'judge_retraction',
    rate_event_id: rate.rate_event_id,
    correction_event_id: correctionEventId,
    disposition: 'retracted',
    idempotent: rate.idempotent,
  };
}
