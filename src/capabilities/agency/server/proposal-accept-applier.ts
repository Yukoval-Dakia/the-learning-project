import type { Db } from '@/db/client';
import type {
  ProposalAcceptApplier,
  ProposalAcceptInput,
  ProposalAcceptResult,
} from '@/kernel/proposals';
import type { ProposalInboxRow } from '@/server/proposals/inbox';
import * as ownerRuntime from '@/server/proposals/owner-runtime';
import { type ConjectureApplierOpts, acceptConjectureProposal } from './conjecture-accept';
import { acceptGoalScopeProposal } from './goals/accept';
import {
  type AgencyApplierOpts,
  acceptCompletionProposal,
  acceptLearningItemProposal,
  acceptRelearnProposal,
} from './proposal-appliers';
import { createAgencyProposalLifecycle } from './proposal-lifecycle';

type AgencyAcceptRuntime = AgencyApplierOpts & ConjectureApplierOpts;

export const {
  completionProposalRetractApplier,
  goalScopeProposalRetractApplier,
  learningItemProposalRetractApplier,
  relearnProposalRetractApplier,
} = createAgencyProposalLifecycle(ownerRuntime);

function inboxView(input: ProposalAcceptInput): ProposalInboxRow {
  const { proposal } = input;
  return {
    ...proposal,
    kind: proposal.payload.kind,
    target: proposal.payload.target,
  } as ProposalInboxRow;
}

function runtimeOptions(input: ProposalAcceptInput, runtime: unknown): AgencyAcceptRuntime {
  const seams = runtime && typeof runtime === 'object' ? (runtime as AgencyAcceptRuntime) : {};
  return {
    ...seams,
    decision: input.decision,
    user_note: input.user_note,
  };
}

function wrap(kind: string, result: unknown): ProposalAcceptResult {
  return { kind, result };
}

export const learningItemProposalAcceptApplier: ProposalAcceptApplier = async (
  db,
  input,
  runtime,
) =>
  wrap(
    'learning_item',
    await acceptLearningItemProposal(
      db as Db,
      input.proposalId,
      inboxView(input),
      runtimeOptions(input, runtime),
    ),
  );

export const completionProposalAcceptApplier: ProposalAcceptApplier = async (db, input, runtime) =>
  wrap(
    'completion',
    await acceptCompletionProposal(
      db as Db,
      input.proposalId,
      inboxView(input),
      runtimeOptions(input, runtime),
    ),
  );

export const relearnProposalAcceptApplier: ProposalAcceptApplier = async (db, input, runtime) =>
  wrap(
    'relearn',
    await acceptRelearnProposal(
      db as Db,
      input.proposalId,
      inboxView(input),
      runtimeOptions(input, runtime),
    ),
  );

export const goalScopeProposalAcceptApplier: ProposalAcceptApplier = async (db, input) => {
  const proposal = inboxView(input);
  const result = await acceptGoalScopeProposal(db as Db, input.proposalId, proposal, {
    user_note: input.user_note,
  });
  if (result.idempotent) {
    await ownerRuntime.ensureProposalDecisionSignal(db as Db, proposal, 'accept', input.user_note);
  } else {
    await ownerRuntime.recordProposalDecisionSignal(db as Db, proposal, 'accept', input.user_note);
  }
  return wrap('goal_scope', result);
};

export const conjectureProposalAcceptApplier: ProposalAcceptApplier = async (db, input, runtime) =>
  wrap(
    'conjecture',
    await acceptConjectureProposal(
      db as Db,
      input.proposalId,
      inboxView(input),
      runtimeOptions(input, runtime),
    ),
  );
