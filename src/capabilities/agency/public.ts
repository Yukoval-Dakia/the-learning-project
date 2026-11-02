// Stable server contract for consumers outside the agency capability.

export { AgentNotesQuerySchema } from './api/contracts';
export {
  learningIntentErrorResponse,
  requestLearningIntent,
} from './api/learning-intent-create';
export { submitConjectureProbeAnswer } from './api/probe-answer';
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
// The platform boss layer mounts the memory pipeline queues; admin config reads its crons and mode.
export type { GenerateBrief } from './server/memory/brief';
export { buildBriefGenerator } from './server/memory/brief-writer';
export {
  MEMORY_RECONCILE_QUEUE,
  memoryReconcileHandoffMode,
} from './server/memory/memory-reconcile-handoff';
export {
  MEMORY_BRIEF_REGEN_QUEUE,
  MEMORY_BRIEF_SWEEP_QUEUE,
  MEMORY_EVENT_INGEST_QUEUE,
  MEMORY_INFRA_SCHEDULES,
  MEMORY_INGEST_OUTBOX_POLL_QUEUE,
  MEMORY_INGEST_OUTBOX_RECOVER_QUEUE,
  type ReconcileMemInput,
  buildMemoryBriefRegenHandler,
  buildMemoryBriefSweepHandler,
  buildMemoryEventIngestHandler,
  buildMemoryIngestOutboxPollHandler,
  buildMemoryIngestOutboxRecoverHandler,
  buildMemoryReconcileHandler,
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
// Task composition uses the narrow task-public entry directly.
export { agencyTaskSpecs } from './task-public';
