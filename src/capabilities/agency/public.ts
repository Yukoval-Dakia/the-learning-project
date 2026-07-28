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
