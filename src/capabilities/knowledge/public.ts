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
export {
  batchResolveEffectiveDomains,
  getEffectiveDomain,
  resolveAllActiveKnowledgeIds,
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
export { KnowledgeIdParamsSchema, KnowledgeTreeQuerySchema } from './api/contracts';
export { runKnowledgeEdgeProposeNightly } from './jobs/knowledge_edge_propose_nightly';
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
export type {
  FailureLearningKnowledgeNode,
  FailureLearningMisconceptionNode,
} from './server/failure-learning-context';
export {
  getMisconceptionsByIds,
  listActiveMisconceptionsForKcs,
  loadFailureLearningKnowledgeContext,
} from './server/failure-learning-context';
// Practice consumes the frontier decision through this narrow port.
export type { FrontierResolution } from './server/frontier-read';
export {
  isMasteredForFrontier,
  learnableFrontierResolved,
  loadFrontierRail,
} from './server/frontier-read';
export type {
  CreateLearningIntentKnowledgeNodeFn,
  CreateLearningIntentKnowledgeNodeInput,
} from './server/learning-intent-knowledge';
export { createLearningIntentKnowledgeNode } from './server/learning-intent-knowledge';
export {
  archiveMisconceptionEdge,
  createMisconceptionEdge,
} from './server/misconception-edges';
export { loadMisconceptionsForKc } from './server/misconception-read';
export {
  createKnowledgeNodeFromEvents,
  ensureSubjectRoot,
  subjectRootId,
  updateSubjectRootNameFromControl,
} from './server/node-creation';
export { loadKnowledgeNodePage } from './server/node-page';
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
export type { NameKcFn } from './server/tag-knowledge';
export { isTagKnowledgeInvariantError, tagKnowledge } from './server/tag-knowledge';
export { loadTreeSnapshot } from './server/tree';
export { knowledgeTaskSpecs } from './task-public';
