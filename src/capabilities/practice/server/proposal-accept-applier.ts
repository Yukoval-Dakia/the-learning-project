import type { Db } from '@/db/client';
import type {
  ProposalAcceptApplier,
  ProposalAcceptInput,
  ProposalAcceptResult,
} from '@/kernel/proposals';
import type { ProposalInboxRow } from '@/server/proposals/inbox';
import {
  type PracticeApplierOpts,
  acceptQuestionDraftProposal,
  acceptQuestionEditProposal,
  acceptVariantQuestionProposal,
} from './proposal-appliers';

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

function wrap(kind: string, result: unknown): ProposalAcceptResult {
  return { kind, result };
}

export const variantQuestionProposalAcceptApplier: ProposalAcceptApplier = async (
  db,
  input,
  runtime,
) =>
  wrap(
    'variant_question',
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
    'question_draft',
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
    'question_edit',
    await acceptQuestionEditProposal(
      db as Db,
      input.proposalId,
      inboxView(input),
      runtimeOptions(input, runtime),
    ),
  );
