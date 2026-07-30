// Stable server contract for consumers outside the agency capability.
export {
  listActiveGoalsWithResolvedScope,
  updateGoalScope,
} from './server/goals/queries';
export type { ActiveGoal } from './server/goals/queries';
export { readAgentNotes } from './server/notes';
export type { ConjectureAcceptResult } from './server/conjecture-accept';
export type { GoalScopeAcceptResult } from './server/goals/accept';
export type {
  CompletionAcceptResult,
  EnqueueLearningIntentNoteFn,
  LearningItemAcceptResult,
  RelearnAcceptResult,
} from './server/proposal-appliers';
export { getEffectiveProbeResultStatuses } from './server/conjecture/probe-evidence';
export type { EffectiveProbeResultStatus } from './server/conjecture/probe-evidence';
export { misconceptionHardConfirmEnabled } from './server/misconception-promote';
export {
  guardInterventionPreparationStage,
  loadInterventionAuthoringContext,
} from './server/intervention/store';
export type { InterventionPreparationStageGuard } from './server/intervention/store';
export { retireInterventionPreparationJobs } from './server/intervention/retire-jobs';
export type { InterventionAuthoringContextT } from './server/intervention/contracts';
