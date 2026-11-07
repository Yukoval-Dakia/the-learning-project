// Stable server contract for consumers outside the agency capability.

export { AgentNotesQuerySchema } from './api/contracts';
export {
  learningIntentErrorResponse,
  requestLearningIntent,
} from './api/learning-intent-create';
export { submitConjectureProbeAnswer } from './api/probe-answer';
export {
  type ConjectureCandidate,
  selectConjectureCandidates,
} from './server/conjecture/candidate-selection';
export type { ConjectureEvidenceImageSource } from './server/conjecture/evidence';
export type { ConjectureImageFetchFn } from './server/conjecture/evidence-images';
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
export { installAgencyHostOperations } from './server/host-operations';
export { retireInterventionPreparationJobs } from './server/intervention/retire-jobs';
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
export {
  type LearningItemUndoDependencies,
  type LearningItemUsageProbe,
  createLearningItemUndoGuard,
} from './server/learning-item-undo-guard';
// The platform boss layer mounts the memory pipeline queues; admin config reads its crons.
export type { GenerateBrief } from './server/memory/brief';
export { buildBriefGenerator } from './server/memory/brief-writer';
// Backup restore reopens outbox rows whose pg-boss job was lost with the queue.
export { reopenUnstartedMemoryIngests } from './server/memory/memory-ingest-recovery-store';
export {
  MEMORY_EVENT_INGEST_QUEUE,
  MEMORY_INFRA_SCHEDULES,
  MEMORY_INGEST_OUTBOX_POLL_QUEUE,
  MEMORY_INGEST_OUTBOX_RECOVER_QUEUE,
  type ReconcileMemInput,
  buildContextPurposeRepairHandler,
  buildMemoryEventIngestHandler,
  buildMemoryIngestOutboxPollHandler,
  buildMemoryIngestOutboxRecoverHandler,
} from './server/memory/triggers';
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
export {
  knowledgeNodesWithGoalScopes,
  knowledgeNodesWithLearningItems,
} from './server/undo-usage';
// Task composition uses the narrow task-public entry directly.
export { agencyTaskSpecs } from './task-public';
