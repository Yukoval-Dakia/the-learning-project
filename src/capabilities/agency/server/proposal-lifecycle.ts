import type { Tx } from '@/db/client';
import type { ProposalRetractApplier } from '@/kernel/proposals';

export type { ProposalInboxRow } from '@/kernel/proposals/inbox';

import { retractGoalCompletionProposal } from './goals/completion';
import { retractGoalScopeProposal } from './proposal-retract-goal';
import { retractLearningItemProposal } from './proposal-retract-learning-item';
import {
  type LearningStateRetractRuntime,
  retractCompletionProposal,
  retractRelearnProposal,
} from './proposal-retract-learning-state';

export function createAgencyProposalLifecycle(runtime: LearningStateRetractRuntime): {
  learningItemProposalRetractApplier: ProposalRetractApplier;
  goalScopeProposalRetractApplier: ProposalRetractApplier;
  completionProposalRetractApplier: ProposalRetractApplier;
  relearnProposalRetractApplier: ProposalRetractApplier;
} {
  return {
    learningItemProposalRetractApplier: (db, input, seams) =>
      retractLearningItemProposal(db as Tx, input, seams),
    goalScopeProposalRetractApplier: (db, input) => retractGoalScopeProposal(db as Tx, input),
    completionProposalRetractApplier: (db, input) =>
      input.proposal.payload.target.subject_kind === 'goal'
        ? retractGoalCompletionProposal(db as Tx, input, runtime)
        : retractCompletionProposal(db as Tx, input, runtime),
    relearnProposalRetractApplier: (db, input) => retractRelearnProposal(db as Tx, input, runtime),
  };
}
