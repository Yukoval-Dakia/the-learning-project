// T4 — practice 包的提议 accept-applier 真身，从 dispatch 壳
// （actions.ts @ src/server/proposals）等价平移（搬迁不改逻辑）。壳退化为
// 纯 dispatch，按 kind 一行委托到这里。
// practice 声明归属的 proposal kinds（manifest.proposals.kinds）：
// - variant_question → acceptVariantQuestionProposal（本文件）
// - question_draft → acceptQuestionDraftProposal（本文件）
// + dismissQuestionDraftProposal（本文件，：
// dismiss tombstone 草稿行 metadata.dismissed_at）
// - judge_retraction → acceptJudgeRetractionProposal（judge-retraction-applier.ts；
// evaluation 目标走 appeal/rejudge/CAS 激活，legacy judge-event 目标写 CorrectEvent）。
// import 环 gate：本文件不得 import producers/writer/actions（含 type-only）；
// 裁决事务走 @/kernel/proposals/decision-protocol，其余共享 helper 走
// @/kernel/proposals/applier-helpers。

import { createId } from '@paralleldrive/cuid2';
import { and, desc, eq, sql } from 'drizzle-orm';
import { newId } from '@/core/ids';
import {
  LEGACY_DRAFT_STATUS,
  MARKING_RULE_PROVENANCE,
  QUESTION_AVAILABILITY,
} from '@/core/schema/assessment/lifecycle';
import type { QuestionEditOpT } from '@/core/schema/proposal';
import type { Db, Tx } from '@/db/client';
import { acquireLearningStateWriteLock } from '@/db/learning-state-lock';
import { event, mistake_variant, question } from '@/db/schema';
import { writeEvent } from '@/kernel/events/index';
import { ApiError } from '@/kernel/http';
import { lockPlacementSupplyScopes } from '@/kernel/locks/placement-supply';
import {
  asPlainRecord,
  ensureAcceptOnly,
  requiredString,
} from '@/kernel/proposals/applier-helpers';
import {
  type ProposalAcceptEffectOutcome,
  type ProposalDismissedResult,
  type RecordedProposalRate,
  runProposalAccept,
  runProposalDismiss,
} from '@/kernel/proposals/decision-protocol';
import type { ProposalInboxRow } from '@/kernel/proposals/inbox';
import { withAnswerClass } from '@/kernel/records/answer-class-write';
import { publishQuestionGroupFromRow } from '@/kernel/records/assessment-publication';
// W2 — mistake_variant accept (E2) write-through. accept already writes the rate(accept)
// event; the per-entity flag gates whether the projection (ON) or the imperative UPDATE (OFF)
// writes the row. OFF still runs the write-time fold==row parity assert.
import {
  hasMistakeVariantGenesisAnchor,
  projectMistakeVariantGuarded,
} from '@/kernel/records/mistake-variant-facts';
import { enrollPromotedQuestionScheduling } from './question-scheduling-enrollment';
import { applyQuestionEdit } from './question-structure-edit';

// swappable enqueue hook so DB tests can drive
// variant_question accept without spinning up pg-boss.
export type EnqueueVariantVerifyFn = (mistakeVariantId: string) => Promise<void>;

export type EnqueueRejudgeFn = (appealEventId: string) => Promise<void>;

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

  const run = await runProposalAccept(db, proposalId, {
    proposal,
    userNote: opts.user_note,
    signal: 'after_commit',
    replay: async (rate: RecordedProposalRate): Promise<VariantQuestionAcceptResult> => {
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
        rate_event_id: rate.id,
        question_id: existingMv.variant_question_id,
        mistake_variant_id: existingMv.id,
        idempotent: true,
      };
    },
    prepare: async () => {
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
      return { proposedChange, mv };
    },
    // The kernel takes the decision lock first, as the variant dismiss and retract take it, so a
    // racing rate (accept or dismiss) cannot land beside this accept; domain locks follow.
    effect: async (
      { tx, writeRate },
      { proposedChange, mv },
    ): Promise<ProposalAcceptEffectOutcome<VariantQuestionAcceptResult>> => {
      const now = new Date();
      const newQuestionId = createId();
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
      const rateEventId = await writeRate({
        created_at: now,
        payload: { materialized_question_id: newQuestionId, mistake_variant_id: mv.id },
      });
      // Materialize canonical structural state from the events in this transaction.
      if (!(await hasMistakeVariantGenesisAnchor(tx, mv.id))) {
        throw new Error(`Variant ${mv.id} needs canonical projection migration`);
      }
      await projectMistakeVariantGuarded(tx, mv.id);
      return {
        status: 'accepted',
        result: {
          kind: 'variant_question',
          rate_event_id: rateEventId,
          question_id: newQuestionId,
          mistake_variant_id: mv.id,
        },
      };
    },
  });
  if (run.outcome !== 'accepted') return run.result;

  const enqueue = opts.enqueueVariantVerify ?? defaultEnqueueVariantVerify;
  try {
    await enqueue(run.result.mistake_variant_id);
  } catch (err) {
    // Mirror attribution_followup → variant_gen wiring: enqueue failure must
    // not roll back the accepted variant. Operator can re-enqueue later.
    console.error('[acceptVariantQuestionProposal] enqueue variant_verify failed', err);
  }
  return run.result;
}

/**
 * question_draft accept. The draft question row
 * was INSERTed at propose time (runQuestionAuthor, same tx as the proposal —
 * 决定4); accept PROMOTES it: draft_status='draft' → 'active' + per-knowledge
 * FSRS enroll-if-absent (copied from the quiz_verify promotion path, the one
 * other place a draft enters the pool) + the rate event, all in the kernel
 * decision transaction. Idempotency keys on caused_by_event_id = proposalId
 * (runProposalAccept), like every sibling accept handler.
 *
 * Dismiss flows through the dedicated questionDraftProposalDismissApplier
 * (, declared in manifest.proposals.kinds): the draft row stays inert
 * (draft_status='draft', never pooled / FSRS'd) AND is tombstoned via
 * metadata.dismissed_at so it stops reading as a live draft — search_bank /
 * listQuestions / the draft-review pool exclude it and write_quiz's narrow
 * draft gate refuses it. A new draft_status value was deliberately NOT
 * introduced: the pool-visibility predicate is fail-open (`<> 'draft'`), so a
 * 'dismissed' literal would leak the row back into every pool read
 * (src/capabilities/practice/question-bank/server/question-bank-write.ts header — same reason archive uses
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

  // The kernel re-checks the decision under the SAME lock the dismiss applier and the
  // generic dismiss/retract paths take. Without it a racing dismiss or retract could commit a
  // second terminal decision alongside this accept, and a dismiss that landed first would leave
  // this accept promoting a row still carrying metadata.dismissed_at (active-but-filtered).
  // Same shape as question_edit: lock → re-read the decision → correction guard → row-locked
  // gates → mutation → rate event.
  const { result } = await runProposalAccept(db, proposalId, {
    proposal,
    userNote: opts.user_note,
    signal: 'after_commit',
    replay: async (rate: RecordedProposalRate): Promise<QuestionDraftAcceptResult> => {
      await loadPromotedRowOrThrow(db);
      return {
        kind: 'question_draft',
        rate_event_id: rate.id,
        question_id: questionId,
        idempotent: true,
      };
    },
    effect: async ({
      tx,
      writeRate,
    }): Promise<ProposalAcceptEffectOutcome<QuestionDraftAcceptResult>> => {
      const now = new Date();
      const rateEventId = newId();
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
      await writeRate({
        id: rateEventId,
        created_at: now,
        payload: { materialized_question_id: questionId },
      });
      return {
        status: 'accepted',
        result: { kind: 'question_draft', rate_event_id: rateEventId, question_id: questionId },
      };
    },
  });
  return result;
}

/**
 * question_draft dismiss applier (previously the phase-deferred gap:
 * the generic dismiss path left the draft row indistinguishable from a live
 * pending one, so search_bank's draft_state=all default and
 * write_quiz's draft admission kept re-surfacing a question the user already
 * rejected).
 *
 * One kernel decision transaction: proposal decision lock → rate(dismiss) event →
 * tombstone the still-draft question row via `metadata.dismissed_at` (+ reason +
 * dismissed_proposal_id provenance); the decision signal follows the commit.
 *
 * The tombstone is a metadata marker, NOT a new draft_status literal: every
 * pool read filters `draft_status IS NULL OR <> 'draft'` (fail-open,
 * 红线-4/NULL≡active), so a 'dismissed' value would be treated as pool-visible
 * and leak the rejected question into due/stream/placement reads
 * (src/capabilities/practice/question-bank/server/question-bank-write.ts header — the archive path made the same
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
): Promise<ProposalDismissedResult> {
  const change = asPlainRecord(proposal.payload.proposed_change);
  const questionId = requiredString(change.question_id, 'question_id', proposalId);

  // Signal bookkeeping runs OUTSIDE the tx (its own signal lock) and only for a new dismiss:
  // the UPSERT increments dismiss_count, so an idempotent replay must not double-count.
  return runProposalDismiss(db, proposalId, {
    proposal,
    userNote: opts.user_note,
    signal: 'after_commit',
    effect: async (tx) => {
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
    },
  });
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
 * the reversible record) AND the `rate` accept event, all in the kernel decision
 * transaction.
 *
 * Idempotency keys on caused_by_event_id = proposalId (runProposalAccept), like
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

  const { result } = await runProposalAccept(db, proposalId, {
    proposal,
    userNote: opts.user_note,
    signal: 'after_commit',
    replay: async (rate: RecordedProposalRate): Promise<QuestionEditAcceptResult> => {
      const existing = await loadAcceptedQuestionOrThrow(db, proposalId, questionId);
      return {
        kind: 'question_edit',
        rate_event_id: rate.id,
        question_id: questionId,
        edit_event_id: null,
        version: existing.version,
        idempotent: true,
      };
    },
    prepare: async () => {
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
      return { row, applied };
    },
    effect: async (
      { tx, writeRate },
      { row, applied },
    ): Promise<ProposalAcceptEffectOutcome<QuestionEditAcceptResult>> => {
      const now = new Date();
      const editEventId = newId();
      const nextVersion = row.version + 1;
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
      const rateEventId = await writeRate({
        created_at: now,
        payload: { materialized_question_id: questionId, structure_edit_event_id: editEventId },
      });
      return {
        status: 'accepted',
        result: {
          kind: 'question_edit',
          rate_event_id: rateEventId,
          question_id: questionId,
          edit_event_id: editEventId,
          version: nextVersion,
        },
      };
    },
  });
  return result;
}

// =============================================================================
// 统一 edit_question 契约提案 accept（edit_request 形状）
// =============================================================================
// Copilot 的 edit_question(save) 落 proposed_change.edit_request =
// {question_id, ops?, document?, draft_ref?, expected_revision?,
// expected_draft_version?}。accept = 经同一 ops → draft → submit gate：
// 1. saveDraftEdit（request_id = proposal-accept:<id> —— 重放幂等）；
// 2. submitDraftQuestion（request_id = proposal-submit:<id> —— CAS/去重/publish 唯一 seam）；
// 3. 裁决事务写 structure-edit 审计 + rate(accept)，提交后记信号。
// CAS 冲突（revision 已动 / draft 版本已动）⇒ 409，proposal 保留 pending。
// save/submit 自己提交，submit 还可能在事务外调 embedding，所以不进裁决事务：
// 两者的每个写事务先经模板的写守卫取裁决锁重查；submit 一旦过闸，撤回与驳回
// 都拒绝（editRequestAcceptApplied），裁决只能由这次接受写完。

function editRequestSubmitId(proposalId: string): string {
  return `proposal-submit:${proposalId}`;
}

type SubmitOutcome = { status: string; published?: boolean };

/** Withheld before any revision was minted: the accept fails without a decision. */
function withheldUnpublished<T extends SubmitOutcome>(
  submitted: T,
): submitted is Extract<T, { published: false }> {
  return submitted.status === 'withheld' && submitted.published === false;
}

/** Every other submit outcome takes the accept on to its decision. */
function submitPassedAcceptGate(submitted: SubmitOutcome): boolean {
  return submitted.status !== 'conflict' && !withheldUnpublished(submitted);
}

/**
 * Whether an edit_request accept has already applied the edit through supply. The caller
 * holds the decision lock, which the submit transaction also held while writing its receipt.
 */
export async function editRequestAcceptApplied(tx: Tx, proposalId: string): Promise<boolean> {
  const [row] = await tx
    .select({ payload: event.payload })
    .from(event)
    .where(
      and(
        eq(event.action, 'experimental:question_draft_submit'),
        sql`${event.payload} ->> 'request_id' = ${editRequestSubmitId(proposalId)}`,
      ),
    )
    .orderBy(desc(event.created_at))
    .limit(1);
  const receipt = (row?.payload as { receipt?: SubmitOutcome } | undefined)?.receipt;
  return receipt != null && submitPassedAcceptGate(receipt);
}

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

  const { result } = await runProposalAccept(db, proposalId, {
    proposal,
    userNote: opts.user_note,
    signal: 'after_commit',
    replay: async (rate: RecordedProposalRate): Promise<QuestionEditAcceptResult> => {
      if (questionId != null) await loadAcceptedQuestionOrThrow(db, proposalId, questionId);
      return {
        kind: 'question_edit',
        rate_event_id: rate.id,
        question_id: questionId ?? 'draft',
        edit_event_id: null,
        version: 0,
        idempotent: true,
      };
    },
    prepare: async (guardWrite) => {
      const { saveDraftEdit, EditQuestionInput } = await import('../../supply/public');
      const { submitDraftQuestion } = await import('../../supply/public');
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
        beforeWrite: guardWrite,
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
          request_id: editRequestSubmitId(proposalId),
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
      if (withheldUnpublished(submitted)) {
        throw new ApiError(
          'unprocessable_entity',
          `submit_question withheld (not published): ${submitted.detail}`,
          422,
        );
      }
      const resolvedQuestionId = 'question_id' in submitted ? submitted.question_id : questionId;
      const nowRow =
        resolvedQuestionId != null
          ? (
              await db.select().from(question).where(eq(question.id, resolvedQuestionId)).limit(1)
            )[0]
          : undefined;
      const nextVersion = nowRow?.version ?? 0;
      return { now, resolvedQuestionId, nextVersion, saved, submitted };
    },
    effect: async (
      { tx, writeRate },
      { now, resolvedQuestionId, nextVersion, saved, submitted },
    ): Promise<ProposalAcceptEffectOutcome<QuestionEditAcceptResult>> => {
      const editEventId = newId();
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
      const rateEventId = await writeRate({
        created_at: now,
        payload: {
          materialized_question_id: resolvedQuestionId,
          structure_edit_event_id: editEventId,
        },
      });
      return {
        status: 'accepted',
        result: {
          kind: 'question_edit',
          rate_event_id: rateEventId,
          question_id: resolvedQuestionId ?? 'draft',
          edit_event_id: editEventId,
          version: nextVersion,
        },
      };
    },
  });
  return result;
}
