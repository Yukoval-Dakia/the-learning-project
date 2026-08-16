// Stable server contract for consumers outside the agency capability.

// YUK-885 — conjecture evidence ports repointed from central deep imports.
export {
  type ConjectureEvidenceAssetRef,
  type ConjectureEvidenceImageSource,
  type EnrichedEvidenceCell,
  type EvidenceCell,
  type LoadedConjectureEvidenceImage,
  collectConjectureEvidenceAssetRefs,
  conjectureKey,
  gatherConjectureEvidence,
} from './server/conjecture/evidence';
export { enrichEvidenceCells } from './server/conjecture/evidence-enrichment';
export {
  type ConjectureHistory,
  applyConjectureHistoryGate,
  loadConjectureHistory,
} from './server/conjecture/history';
export type {
  InduceConjectureInput,
  InduceConjectureResult,
} from './server/conjecture/induce';
export { induceConjecture } from './server/conjecture/induce';
export type { EffectiveProbeResultStatus } from './server/conjecture/probe-evidence';
export { getEffectiveProbeResultStatuses } from './server/conjecture/probe-evidence';
export type { ConjectureAcceptResult } from './server/conjecture-accept';
export type { GoalScopeAcceptResult } from './server/goals/accept';
export type { ActiveGoal } from './server/goals/queries';
export {
  listActiveGoalsWithResolvedScope,
  updateGoalScope,
} from './server/goals/queries';
export type { InterventionAuthoringContextT } from './server/intervention/contracts';
export { retireInterventionPreparationJobs } from './server/intervention/retire-jobs';
export type { InterventionPreparationStageGuard } from './server/intervention/store';
export {
  guardInterventionPreparationStage,
  loadInterventionAuthoringContext,
} from './server/intervention/store';
export type {
  AcceptLearningIntentParams,
  LearningIntentMaterializeResult,
  LearningIntentProposal,
  PlanLearningIntentParams,
  RunTaskFn,
} from './server/learning-intent';
export {
  acceptLearningIntent,
  parseLearningIntentOutline,
  planLearningIntent,
} from './server/learning-intent';
export { misconceptionHardConfirmEnabled } from './server/misconception-promote';
export { readAgentNotes, writeAgentNote } from './server/notes';
export type {
  CompletionAcceptResult,
  EnqueueLearningIntentNoteFn,
  LearningItemAcceptResult,
  RelearnAcceptResult,
} from './server/proposal-appliers';
export type { BriefDraftOutput } from './tasks/memory-brief';
export { BriefDraftOutputSchema, parseBriefDraftOutput } from './tasks/memory-brief';
