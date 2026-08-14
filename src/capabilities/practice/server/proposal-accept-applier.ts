import type { Db } from '@/db/client';
import type {
  ProposalAcceptApplier,
  ProposalAcceptInput,
  ProposalAcceptResult,
  ProposalDismissInput,
} from '@/kernel/proposals';
import { toProposalLifecycleResult } from '@/kernel/proposals';
import {
  type ProposalInboxRow,
  assertCurrentMistakeVariantParity,
  findExistingRateEvent,
  hasMistakeVariantGenesisAnchor,
  projectMistakeVariantGuarded,
  projectionIsWriter,
  recordProposalDecisionSignal,
  writeProposalRateEvent,
} from '@/server/proposals/practice-runtime';
import {
  type PracticeApplierOpts,
  acceptQuestionDraftProposal,
  acceptQuestionEditProposal,
  acceptVariantQuestionProposal,
} from './proposal-appliers';
import { createPracticeProposalLifecycle } from './proposal-lifecycle';

export const {
  questionEditProposalRetractApplier,
  variantQuestionProposalDismissApplier,
  variantQuestionProposalRetractApplier,
} = createPracticeProposalLifecycle({
  assertCurrentMistakeVariantParity,
  findExistingRateEvent,
  hasMistakeVariantGenesisAnchor,
  projectMistakeVariantGuarded,
  projectionIsWriter,
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

function inboxView(input: ProposalAcceptInput): ProposalInboxRow {
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
