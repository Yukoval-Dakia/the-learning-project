import type { Db } from '@/db/client';
import { findExistingRateEvent, writeProposalRateEvent } from '@/kernel/proposals/applier-helpers';
import type { ProposalInboxRow } from '@/kernel/proposals/inbox';
import type {
  ProposalAcceptApplier,
  ProposalAcceptInput,
  ProposalAcceptResult,
  ProposalDismissApplier,
  ProposalDismissInput,
  ProposalDismissResult,
} from '@/kernel/proposals/index';
import { toProposalLifecycleResult } from '@/kernel/proposals/index';
import { recordProposalDecisionSignal } from '@/kernel/proposals/signals';
import {
  hasMistakeVariantGenesisAnchor,
  projectMistakeVariantGuarded,
} from '@/kernel/records/mistake-variant-facts';
import { acceptJudgeRetractionProposal } from '../../server/judge-retraction-applier';
import {
  type PracticeApplierOpts,
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

// question_draft dismiss: tombstone the still-draft question row via
// metadata.dismissed_at (see dismissQuestionDraftProposal) so a user-rejected
// draft stops re-surfacing through search_bank / write_quiz / the
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

// judge_retraction accept：判分纠错提案（evaluation 目标走
// appeal/rejudge/CAS 激活 + settlement replay；legacy judge-event 目标写
// CorrectEvent）。真身在 judge-retraction-applier.ts。
export const judgeRetractionProposalAcceptApplier: ProposalAcceptApplier = async (
  db,
  input,
  runtime,
) =>
  wrap(
    await acceptJudgeRetractionProposal(
      db as Db,
      input.proposalId,
      inboxView(input),
      runtimeOptions(input, runtime),
    ),
  );
