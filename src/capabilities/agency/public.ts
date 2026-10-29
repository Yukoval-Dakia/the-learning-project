// Stable server contract for consumers outside the agency capability.

export { AgentNotesQuerySchema } from './api/contracts';
export {
  type PredictionAccountability,
  loadPredictionAccountabilityByKey,
  rankEvidenceCellsByAccountability,
} from './server/conjecture/accountability';
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
// Shared probe lifecycle exercised by shell integration consumers.
export {
  answerProbe,
  serveProbeOnce,
  servePublishedProbe,
} from './server/conjecture/probe-lifecycle';
export type { ConjectureAcceptResult } from './server/conjecture-accept';
export type { GoalScopeAcceptResult } from './server/goals/accept';
export { createGoal } from './server/goals/create';
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
export {
  type AgentNoteBoardDto,
  type AgentNoteBoardQuery,
  type AgentNoteBoardRowDto,
  loadAgentNoteBoard,
} from './server/note-board-read';
export { readAgentNotes, recordQuestionPoolGap, writeAgentNote } from './server/notes';
export type {
  CompletionAcceptResult,
  EnqueueLearningIntentNoteFn,
  LearningItemAcceptResult,
  RelearnAcceptResult,
} from './server/proposal-appliers';
// Task composition uses the narrow task-public entry directly.
export { agencyTaskSpecs } from './task-public';
export type { BriefDraftOutput } from './tasks/memory-brief';
export { BriefDraftOutputSchema, parseBriefDraftOutput } from './tasks/memory-brief';
