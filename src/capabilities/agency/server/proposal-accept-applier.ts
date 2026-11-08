import type { Db } from '@/db/client';
import { shouldEnqueueBackgroundJobs } from '@/kernel/background-job-enqueue';
import type {
  ProposalAcceptApplier,
  ProposalAcceptInput,
  ProposalAcceptResult,
  ProposalDismissApplier,
} from '@/kernel/proposals';
import { findExistingRateEvent } from '@/kernel/proposals/applier-helpers';
import { runProposalDismiss } from '@/kernel/proposals/decision-protocol';
import { createLearningIntentNote } from '@/kernel/records/learning-intent-note-birth';
import { type BossDispatch, dispatchNoteGeneration } from '@/kernel/records/note-handoff-protocol';
import { type ConjectureApplierOpts, acceptConjectureProposal } from './conjecture-accept';
import { acceptGoalScopeProposal } from './goals/accept';
import { createLearningIntentKnowledgeNode } from './learning-intent';
import {
  type AgencyApplierOpts,
  acceptCompletionProposal,
  acceptLearningItemProposal,
  acceptRelearnProposal,
} from './proposal-appliers';
import { type ProposalInboxRow, createAgencyProposalLifecycle } from './proposal-lifecycle';

type AgencyAcceptRuntime = AgencyApplierOpts &
  ConjectureApplierOpts & {
    // The accept dispatcher supplies the boss; agency does not import the platform client.
    readonly getBoss?: () => Promise<BossDispatch>;
  };

export const {
  completionProposalRetractApplier,
  goalScopeProposalRetractApplier,
  learningItemProposalRetractApplier,
  relearnProposalRetractApplier,
} = createAgencyProposalLifecycle({ findExistingRateEvent });

function inboxView(input: Pick<ProposalAcceptInput, 'proposal'>): ProposalInboxRow {
  const { proposal } = input;
  return {
    ...proposal,
    kind: proposal.payload.kind,
    target: proposal.payload.target,
  } as ProposalInboxRow;
}

function runtimeOptions(db: Db, input: ProposalAcceptInput, runtime: unknown): AgencyAcceptRuntime {
  const seams = runtime && typeof runtime === 'object' ? (runtime as AgencyAcceptRuntime) : {};
  const { getBoss } = seams;
  const enqueueLearningIntentNote =
    seams.enqueueLearningIntentNote ??
    (shouldEnqueueBackgroundJobs() && getBoss
      ? async (artifactId: string) =>
          dispatchNoteGeneration(db as Db, artifactId, { boss: await getBoss() })
      : undefined);
  return {
    ...seams,
    ...(enqueueLearningIntentNote ? { enqueueLearningIntentNote } : {}),
    createLearningIntentKnowledgeNode,
    createLearningIntentNote,
    decision: input.decision,
    user_note: input.user_note,
    corrected_payload: input.corrected_payload,
    ...(input.actor ? { actor: input.actor } : {}),
  };
}

function wrap(result: {
  readonly kind: string;
  readonly idempotent?: boolean;
}): ProposalAcceptResult {
  return { kind: result.kind, result: { ...result } };
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

export const goalScopeProposalAcceptApplier: ProposalAcceptApplier = async (db, input) =>
  wrap(
    await acceptGoalScopeProposal(db as Db, input.proposalId, inboxView(input), {
      user_note: input.user_note,
    }),
  );

export const agencyProposalDismissApplier: ProposalDismissApplier = async (db, input) => ({
  kind: input.proposal.payload.kind,
  result: await runProposalDismiss(db as Db, input.proposalId, {
    proposal: inboxView(input),
    userNote: input.user_note,
    signal: 'in_transaction',
  }),
});

export const conjectureProposalAcceptApplier: ProposalAcceptApplier = async (db, input, runtime) =>
  wrap(
    await acceptConjectureProposal(
      db as Db,
      input.proposalId,
      inboxView(input),
      runtimeOptions(db as Db, input, runtime),
    ),
  );
