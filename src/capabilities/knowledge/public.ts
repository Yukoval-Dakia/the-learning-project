// Stable server contract for consumers outside the knowledge capability.

export { isDirectTreePair } from '@/core/topology-gate';
export { loadConfusablePairs } from '@/kernel/read-models/confusables';
export type {
  FailureAttempt,
  FailureAttemptJudge,
  FailureAttemptUserCause,
  FailureAttemptWithReasoningTrace,
  GetFailureAttemptsOpts,
} from '@/kernel/read-models/failure-attempts';
export {
  getFailureAttemptById,
  getFailureAttemptWithReasoningTraceById,
  getFailureAttempts,
  getFailureAttemptsWithReasoningTrace,
  getJudgeForAttempt,
} from '@/kernel/read-models/failure-attempts';
export type {
  KnowledgeCardPractice,
  KnowledgeEntityCard,
} from '@/kernel/read-models/knowledge-card';
export {
  isKnowledgeCardVisible,
  readKnowledgeEntityCard,
} from '@/kernel/read-models/knowledge-card';
export {
  batchResolveEffectiveDomains,
  getEffectiveDomain,
  resolveSubjectKnowledgeIds,
} from '@/kernel/read-models/knowledge-tree';
export { assertKnowledgeIdsExist } from '@/kernel/read-models/knowledge-validate';
export {
  assertCauseAllowedForSubjectProfile,
  resolveSubjectProfileForKnowledgeIds,
  resolveSubjectProfileForKnowledgeIdsStrict,
} from '@/kernel/read-models/subject-profile';
export {
  batchResolveSubjectDisplayIds,
  batchResolveSubjectIds,
  resolveSubjectRenderNotation,
} from '@/kernel/read-models/subject-resolution';
export { KnowledgeIdParamsSchema } from './api/contracts';
export { knowledgeConfigEffectiveFacts } from './server/config-effective-facts';
export { createManualKnowledgeEdge } from './server/edge-create';
export type {
  EdgeProposalDecision,
  EdgeProposalDecisionInput,
  KnowledgeEdgeProposalDecisionResult,
} from './server/edge-proposal-accept';
export { decideKnowledgeEdgeProposal } from './server/edge-proposal-accept';
export {
  archiveKnowledgeEdgeFromEvents,
  listKnowledgeEdges,
  listKnowledgeEdgesPage,
} from './server/edges';
export { readKnowledgeEdges } from './server/edges-list';
export { loadFrontierRail } from './server/frontier-read';
export {
  readLearnerKnowledgeNodePage,
  readLearnerKnowledgeTree,
} from './server/learner-knowledge-request';
export { loadMisconceptionsForKc } from './server/misconception-read';
export type { AcceptResult as KnowledgeAcceptResult } from './server/proposals';
export {
  ACCEPT_RESULT_KINDS,
  acceptProposal,
  dismissProposal,
  writeKnowledgeProposeEvent,
} from './server/proposals';
export { loadReviewDueSummary } from './server/review-due-summary';
export type { RubricGate } from './server/rubric-validator';
export { seedKnowledge } from './server/seed';
export {
  type KnowledgeNodeUndoDependencies,
  type KnowledgeNodeUsageProbe,
  createKnowledgeNodeUndoGuard,
} from './server/undo-guard';
export { knowledgeTaskSpecs } from './task-public';
