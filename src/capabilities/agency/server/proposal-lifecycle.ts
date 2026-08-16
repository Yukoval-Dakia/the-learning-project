import type { Db, Tx } from '@/db/client';
import type {
  ProposalDismissApplier,
  ProposalDismissInput,
  ProposalRetractApplier,
} from '@/kernel/proposals';

export type { ProposalInboxRow } from '@/kernel/proposals/inbox';

import { type GoalRetractRuntime, retractGoalScopeProposal } from './proposal-retract-goal';
import {
  type LearningItemRetractRuntime,
  retractLearningItemProposal,
} from './proposal-retract-learning-item';
import {
  type LearningStateRetractRuntime,
  retractCompletionProposal,
  retractRelearnProposal,
} from './proposal-retract-learning-state';

type AgencyLifecycleRuntime = GoalRetractRuntime &
  LearningItemRetractRuntime &
  LearningStateRetractRuntime & {
    acquireProposalDecisionLock: (tx: Tx, proposalId: string) => Promise<void>;
    recordDismissSignal: (tx: Tx, input: ProposalDismissInput) => Promise<void>;
    writeProposalRateEvent: (
      tx: Tx,
      proposalId: string,
      rating: 'accept' | 'dismiss',
      userNote?: string,
    ) => Promise<{ rate_event_id: string | null; idempotent?: boolean }>;
  };

export function createAgencyProposalLifecycle(runtime: AgencyLifecycleRuntime): {
  agencyProposalDismissApplier: ProposalDismissApplier;
  learningItemProposalRetractApplier: ProposalRetractApplier;
  goalScopeProposalRetractApplier: ProposalRetractApplier;
  completionProposalRetractApplier: ProposalRetractApplier;
  relearnProposalRetractApplier: ProposalRetractApplier;
} {
  return {
    agencyProposalDismissApplier: async (db, input) =>
      (db as Db).transaction(async (tx) => {
        await runtime.acquireProposalDecisionLock(tx, input.proposalId);
        const rate = await runtime.writeProposalRateEvent(
          tx,
          input.proposalId,
          'dismiss',
          input.user_note,
        );
        if (!rate.idempotent) await runtime.recordDismissSignal(tx, input);
        return {
          kind: input.proposal.payload.kind,
          result: {
            kind: 'dismissed',
            rate_event_id: rate.rate_event_id,
            ...(rate.idempotent ? { idempotent: true } : {}),
          },
        };
      }),
    learningItemProposalRetractApplier: (db, input) =>
      retractLearningItemProposal(db as Tx, input, runtime),
    goalScopeProposalRetractApplier: (db, input) =>
      retractGoalScopeProposal(db as Tx, input, runtime),
    completionProposalRetractApplier: (db, input) =>
      retractCompletionProposal(db as Tx, input, runtime),
    relearnProposalRetractApplier: (db, input) => retractRelearnProposal(db as Tx, input, runtime),
  };
}
