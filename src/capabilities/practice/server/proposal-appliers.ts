// M4-T4 (YUK-319) — practice 包的提议 accept-applier 真身，从 dispatch 壳
// （actions.ts @ src/server/proposals）等价平移（搬迁不改逻辑）。壳退化为
// 纯 dispatch，按 kind 一行委托到这里。
//
// practice 声明归属的 proposal kinds（manifest.proposals.kinds）：
//   - variant_question  → acceptVariantQuestionProposal（本文件）
//   - question_draft    → acceptQuestionDraftProposal（本文件）
//   - judge_retraction  → 有 producer（producers.ts 的 judge_retraction 提议）
//     但无 accept applier：accept 走 actions.ts 的 default throw
//     （unsupported_proposal_kind），剩余 producer 语义归 YUK-44。归属声明
//     与 applier 存在性解耦（见 kernel/manifest.ts 的 ProposalKindDecl 注释）。
//
// import 环 gate：本文件不得 import producers/writer/actions（含 type-only）；
// 共享 helper 一律走 @/server/proposals/applier-helpers。

import { createId } from '@paralleldrive/cuid2';
import { and, eq } from 'drizzle-orm';

import { newId } from '@/core/ids';
import type { Db } from '@/db/client';
import { event, mistake_variant, question } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import { getFsrsState, upsertFsrsState } from '@/server/fsrs/state';
import { ApiError } from '@/server/http/errors';
import {
  asPlainRecord,
  ensureAcceptOnly,
  existingAcceptRate,
  requiredString,
} from '@/server/proposals/applier-helpers';
import type { ProposalInboxRow } from '@/server/proposals/inbox';
import {
  ensureProposalDecisionSignal,
  recordProposalDecisionSignal,
} from '@/server/proposals/signals';

import { initialFsrsState } from './fsrs';

// YUK-17 / ADR-0018 — swappable enqueue hook so DB tests can drive
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

// ADR-0031 / YUK-304 (lane B) — copilot-authored draft question accept.
export interface QuestionDraftAcceptResult {
  kind: 'question_draft';
  rate_event_id: string;
  question_id: string;
  idempotent?: boolean;
}

// Structural-minimal opts: the dispatch shell's AcceptAiProposalOpts is
// assignable to this (appliers must not import actions.ts for the full type).
export interface PracticeApplierOpts {
  decision?: string;
  user_note?: string;
  // YUK-17 — swappable enqueue (DB tests inject a no-op or vi.fn).
  enqueueVariantVerify?: EnqueueVariantVerifyFn;
}

/**
 * YUK-17 / ADR-0018 — variant_question accept materializes the question row
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
    if (!existingMv || !existingMv.variant_question_id) {
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

  await db.transaction(async (tx) => {
    await tx.insert(question).values({
      id: newQuestionId,
      kind: 'short_answer',
      prompt_md: proposedChange.prompt_md as string,
      reference_md: proposedChange.reference_md ?? null,
      knowledge_ids: proposedChange.knowledge_ids ?? [],
      difficulty: proposedChange.difficulty as number,
      source: 'mistake_variant',
      draft_status: 'active',
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
    });

    await tx
      .update(mistake_variant)
      .set({
        status: 'active',
        variant_question_id: newQuestionId,
        updated_at: now,
      })
      .where(eq(mistake_variant.id, mv.id));

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
 * ADR-0031 / YUK-304 (lane B) — question_draft accept. The draft question row
 * was INSERTed at propose time (runQuestionAuthor, same tx as the proposal —
 * 决定4); accept PROMOTES it: draft_status='draft' → 'active' + per-knowledge
 * FSRS enroll-if-absent (copied from the quiz_verify promotion path, the one
 * other place a draft enters the pool) + the rate event, all in one
 * transaction. Idempotency keys on caused_by_event_id = proposalId
 * (existingAcceptRate), like every sibling accept handler.
 *
 * Dismiss flows through the generic dismiss path (writeGenericRateEvent): the
 * draft row stays inert (draft_status='draft', never pooled / FSRS'd).
 * phase-deferred: dismissed-draft cleanup/archival is NOT implemented — orphan
 * draft rows accumulate harmlessly (invisible everywhere drafts are excluded).
 * Revisit with the YUK-304 follow-up batch; context: ADR-0031 决定5 + this
 * handler.
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

  // Already-accepted idempotency: a rate event exists (409s on a non-accept
  // decision inside existingAcceptRate).
  const existingRate = await existingAcceptRate(db, proposalId);
  if (existingRate) {
    await ensureProposalDecisionSignal(db, proposal, 'accept', opts.user_note);
    const existing = (
      await db.select().from(question).where(eq(question.id, questionId)).limit(1)
    )[0];
    if (!existing || existing.draft_status === 'draft') {
      // Rate was written but the promotion did not complete — surface explicitly
      // rather than silently fixing up (variant_question precedent).
      throw new ApiError(
        'inconsistent_state',
        `proposal ${proposalId} has an accept rate event but question ${questionId} is ${existing ? 'still draft' : 'missing'}; retract + retry`,
        500,
      );
    }
    return {
      kind: 'question_draft',
      rate_event_id: existingRate.id,
      question_id: questionId,
      idempotent: true,
    };
  }

  const row = (await db.select().from(question).where(eq(question.id, questionId)).limit(1))[0];
  if (!row) {
    throw new ApiError('not_found', `question ${questionId} not found`, 404);
  }
  if (row.draft_status !== 'draft') {
    throw new ApiError(
      'conflict',
      `question ${questionId} is in draft_status ${row.draft_status ?? 'null'}, expected 'draft'`,
      409,
    );
  }

  const now = new Date();
  const rateEventId = newId();

  await db.transaction(async (tx) => {
    await tx
      .update(question)
      .set({ draft_status: 'active', updated_at: now })
      .where(eq(question.id, questionId));

    // FSRS enroll — copied from quiz_verify.ts (YUK-203 P3): per-knowledge
    // enroll-if-absent so a node with an existing review schedule is never
    // reset; question-level fallback when the row carries no knowledge ids.
    const initial = initialFsrsState(now);
    const fsrsSubjectIds = Array.from(new Set(row.knowledge_ids ?? []));
    if (fsrsSubjectIds.length > 0) {
      for (const knowledgeId of fsrsSubjectIds) {
        const existing = await getFsrsState(tx, 'knowledge', knowledgeId);
        if (existing) continue;
        await upsertFsrsState(tx, {
          subject_kind: 'knowledge',
          subject_id: knowledgeId,
          state: initial.state,
          due_at: initial.dueAt,
          last_review_event_id: rateEventId,
        });
      }
    } else {
      const existing = await getFsrsState(tx, 'question', questionId);
      if (!existing) {
        await upsertFsrsState(tx, {
          subject_kind: 'question',
          subject_id: questionId,
          state: initial.state,
          due_at: initial.dueAt,
          last_review_event_id: rateEventId,
        });
      }
    }

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
  });

  await recordProposalDecisionSignal(db, proposal, 'accept', opts.user_note);

  return { kind: 'question_draft', rate_event_id: rateEventId, question_id: questionId };
}
