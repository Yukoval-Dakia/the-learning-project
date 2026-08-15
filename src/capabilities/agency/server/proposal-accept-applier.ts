import { createLearningIntentKnowledgeNode } from '@/capabilities/knowledge/public';
import { createLearningIntentNote, dispatchNoteGeneration } from '@/capabilities/notes/public';
import type { Db } from '@/db/client';
import type {
  ProposalAcceptApplier,
  ProposalAcceptInput,
  ProposalAcceptResult,
  ProposalDismissInput,
} from '@/kernel/proposals';
import { toProposalLifecycleResult } from '@/kernel/proposals';
import * as ownerRuntime from '@/server/proposals/owner-runtime';
import { shouldEnqueueBackgroundJobs } from '@/server/runtime-env';
import { type ConjectureApplierOpts, acceptConjectureProposal } from './conjecture-accept';
import { acceptGoalScopeProposal } from './goals/accept';
import {
  type AgencyApplierOpts,
  acceptCompletionProposal,
  acceptLearningItemProposal,
  acceptRelearnProposal,
} from './proposal-appliers';
import { type ProposalInboxRow, createAgencyProposalLifecycle } from './proposal-lifecycle';

type AgencyAcceptRuntime = AgencyApplierOpts & ConjectureApplierOpts;

export const {
  agencyProposalDismissApplier,
  completionProposalRetractApplier,
  goalScopeProposalRetractApplier,
  learningItemProposalRetractApplier,
  relearnProposalRetractApplier,
} = createAgencyProposalLifecycle({
  ...ownerRuntime,
  recordDismissSignal: (db, input: ProposalDismissInput) =>
    ownerRuntime.recordProposalDecisionSignal(
      db,
      {
        ...input.proposal,
        kind: input.proposal.payload.kind,
        target: input.proposal.payload.target,
      } as ProposalInboxRow,
      'dismiss',
      input.user_note,
    ),
});

function inboxView(input: ProposalAcceptInput): ProposalInboxRow {
  const { proposal } = input;
  return {
    ...proposal,
    kind: proposal.payload.kind,
    target: proposal.payload.target,
  } as ProposalInboxRow;
}

function runtimeOptions(db: Db, input: ProposalAcceptInput, runtime: unknown): AgencyAcceptRuntime {
  const seams = runtime && typeof runtime === 'object' ? (runtime as AgencyAcceptRuntime) : {};
  const enqueueLearningIntentNote =
    seams.enqueueLearningIntentNote ??
    (shouldEnqueueBackgroundJobs()
      ? (artifactId: string) => dispatchNoteGeneration(db, artifactId)
      : undefined);
  return {
    ...seams,
    ...(enqueueLearningIntentNote ? { enqueueLearningIntentNote } : {}),
    createLearningIntentKnowledgeNode,
    createLearningIntentNote,
    decision: input.decision,
    user_note: input.user_note,
    corrected_payload: input.corrected_payload,
  };
}

function wrap(result: {
  readonly kind: string;
  readonly idempotent?: boolean;
}): ProposalAcceptResult {
  return { kind: result.kind, result: toProposalLifecycleResult(result) };
}

export const learningItemProposalAcceptApplier: ProposalAcceptApplier = async (
  db,
  input,
  runtime,
) =>
  wrap(
    await acceptLearningItemProposal(
      db as Db,
      input.proposalId,
      inboxView(input),
      runtimeOptions(db as Db, input, runtime),
    ),
  );

export const completionProposalAcceptApplier: ProposalAcceptApplier = async (db, input, runtime) =>
  wrap(
    await acceptCompletionProposal(
      db as Db,
      input.proposalId,
      inboxView(input),
      runtimeOptions(db as Db, input, runtime),
    ),
  );

export const relearnProposalAcceptApplier: ProposalAcceptApplier = async (db, input, runtime) =>
  wrap(
    await acceptRelearnProposal(
      db as Db,
      input.proposalId,
      inboxView(input),
      runtimeOptions(db as Db, input, runtime),
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
  return wrap(result);
};

export const conjectureProposalAcceptApplier: ProposalAcceptApplier = async (db, input, runtime) =>
  wrap(
    await acceptConjectureProposal(
      db as Db,
      input.proposalId,
      inboxView(input),
      runtimeOptions(db as Db, input, runtime),
    ),
  );
