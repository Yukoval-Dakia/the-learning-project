import { and, eq } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { cause_category_overlay } from '@/db/schema';
import type {
  ProposalAcceptApplier,
  ProposalAcceptInput,
  ProposalAcceptResult,
  ProposalDismissApplier,
  ProposalDismissInput,
  ProposalDismissResult,
  ProposalRetractApplier,
} from '@/kernel/proposals';
import { requireLaterProposalCorrection, toProposalLifecycleResult } from '@/kernel/proposals';
import {
  type ProposalInboxRow,
  asPlainRecord,
  findExistingRateEvent,
  hasMistakeVariantGenesisAnchor,
  projectMistakeVariantGuarded,
  recordProposalDecisionSignal,
  writeProposalRateEvent,
} from '@/server/proposals/practice-runtime';
import {
  type PracticeApplierOpts,
  acceptCauseCategoryProposal,
  acceptQuestionDraftProposal,
  acceptQuestionEditProposal,
  acceptVariantQuestionProposal,
  dismissQuestionDraftProposal,
} from './proposal-appliers';
import { createPracticeProposalLifecycle } from './proposal-lifecycle';

export const {
  questionEditProposalRetractApplier,
  variantQuestionProposalDismissApplier,
  variantQuestionProposalRetractApplier,
} = createPracticeProposalLifecycle({
  findExistingRateEvent,
  hasMistakeVariantGenesisAnchor,
  projectMistakeVariantGuarded,
  recordDismissSignal: (db: Db, input: ProposalDismissInput) =>
    recordProposalDecisionSignal(
      db,
      {
        ...input.proposal,
        kind: input.proposal.payload.kind,
        target: input.proposal.payload.target,
      } as ProposalInboxRow,
      'dismiss',
      input.user_note,
    ),
  writeProposalRateEvent,
});

function inboxView(input: { proposal: ProposalAcceptInput['proposal'] }): ProposalInboxRow {
  const { proposal } = input;
  return {
    ...proposal,
    kind: proposal.payload.kind,
    target: proposal.payload.target,
  } as ProposalInboxRow;
}

function runtimeOptions(input: ProposalAcceptInput, runtime: unknown): PracticeApplierOpts {
  const seams = runtime && typeof runtime === 'object' ? (runtime as PracticeApplierOpts) : {};
  return {
    ...seams,
    decision: input.decision,
    user_note: input.user_note,
  };
}

function wrap(result: {
  readonly kind: string;
  readonly idempotent?: boolean;
}): ProposalAcceptResult {
  return { kind: result.kind, result: toProposalLifecycleResult(result) };
}

export const variantQuestionProposalAcceptApplier: ProposalAcceptApplier = async (
  db,
  input,
  runtime,
) =>
  wrap(
    await acceptVariantQuestionProposal(
      db as Db,
      input.proposalId,
      inboxView(input),
      runtimeOptions(input, runtime),
    ),
  );

export const questionDraftProposalAcceptApplier: ProposalAcceptApplier = async (
  db,
  input,
  runtime,
) =>
  wrap(
    await acceptQuestionDraftProposal(
      db as Db,
      input.proposalId,
      inboxView(input),
      runtimeOptions(input, runtime),
    ),
  );

// YUK-308 — question_draft dismiss: tombstone the still-draft question row via
// metadata.dismissed_at (see dismissQuestionDraftProposal) so a user-rejected
// draft stops re-surfacing through query_questions / write_quiz / the
// draft-review pool. Replaces the generic write-only rate path for this kind.
export const questionDraftProposalDismissApplier: ProposalDismissApplier = async (db, input) => {
  const result = await dismissQuestionDraftProposal(
    db as Db,
    input.proposalId,
    inboxView({ proposal: input.proposal }),
    { user_note: input.user_note },
  );
  return {
    kind: input.proposal.payload.kind,
    result: toProposalLifecycleResult(result),
  } satisfies ProposalDismissResult;
};

export const questionEditProposalAcceptApplier: ProposalAcceptApplier = async (
  db,
  input,
  runtime,
) =>
  wrap(
    await acceptQuestionEditProposal(
      db as Db,
      input.proposalId,
      inboxView(input),
      runtimeOptions(input, runtime),
    ),
  );

// YUK-1016 / 454-B — cause_category accept：往 cause_category_overlay INSERT
// status='active' 行（applier 真身在 proposal-appliers.ts）。
export const causeCategoryProposalAcceptApplier: ProposalAcceptApplier = async (
  db,
  input,
  runtime,
) =>
  wrap(
    await acceptCauseCategoryProposal(
      db as Db,
      input.proposalId,
      inboxView(input),
      runtimeOptions(input, runtime),
    ),
  );

// YUK-1016 — retract 语义：accept 已落 overlay 行 → 置 archived_at（唯一回退
// 维度）。行按 proposal_event_id 归属限定——同 slug 两张 pending proposal 并存
// 时，retract 未落地那张不许归档别人 accept 的活行（mistake_variant 同款归属
// 语义）。proposal 从未被 accept（pending 即 retract，行不存在）、行非本
// proposal 所立、或已归档时幂等 no-op。
export const causeCategoryProposalRetractApplier: ProposalRetractApplier = async (db, input) => {
  const tx = db as Tx;
  const change = asPlainRecord(input.proposal.payload.proposed_change);
  const categoryId =
    typeof change.category_id === 'string' && change.category_id.length > 0
      ? change.category_id
      : null;
  if (!categoryId) return;
  const ownedRow = and(
    eq(cause_category_overlay.id, categoryId),
    eq(cause_category_overlay.proposal_event_id, input.proposalId),
  );
  const [row] = await tx
    .select({
      id: cause_category_overlay.id,
      updated_at: cause_category_overlay.updated_at,
      archived_at: cause_category_overlay.archived_at,
    })
    .from(cause_category_overlay)
    .where(ownedRow)
    .for('update')
    .limit(1);
  if (!row || row.archived_at !== null) return;
  requireLaterProposalCorrection(input.correction_at, row.updated_at);
  await tx
    .update(cause_category_overlay)
    .set({ archived_at: input.correction_at, updated_at: input.correction_at })
    .where(ownedRow);
};
