import type { Tx } from '@/db/client';
import type { ProposalRetractApplier } from '@/kernel/proposals';
export type { ProposalInboxRow } from '@/server/proposals/inbox';
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
  LearningStateRetractRuntime;

export function createAgencyProposalLifecycle(runtime: AgencyLifecycleRuntime): {
  learningItemProposalRetractApplier: ProposalRetractApplier;
  goalScopeProposalRetractApplier: ProposalRetractApplier;
  completionProposalRetractApplier: ProposalRetractApplier;
  relearnProposalRetractApplier: ProposalRetractApplier;
} {
  return {
    learningItemProposalRetractApplier: (db, input) =>
      retractLearningItemProposal(db as Tx, input, runtime),
    goalScopeProposalRetractApplier: (db, input) =>
      retractGoalScopeProposal(db as Tx, input, runtime),
    completionProposalRetractApplier: (db, input) =>
      retractCompletionProposal(db as Tx, input, runtime),
    relearnProposalRetractApplier: (db, input) => retractRelearnProposal(db as Tx, input, runtime),
  };
}
