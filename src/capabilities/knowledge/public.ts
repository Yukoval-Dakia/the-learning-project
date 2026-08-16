// Stable server contract for consumers outside the knowledge capability.
//
// YUK-876 / FULL F3.7b — the failure-attempt evidence + attribution read models
// (moved from src/server/events/queries.ts) are part of this contract.

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
export type {
  EdgeProposalDecision,
  EdgeProposalDecisionInput,
  KnowledgeEdgeProposalDecisionResult,
} from './server/edge-proposal-accept';
export { decideKnowledgeEdgeProposal } from './server/edge-proposal-accept';
export { archiveKnowledgeEdge, listKnowledgeEdges, listKnowledgeEdgesPage } from './server/edges';
export type { FailureLearningKnowledgeNode } from './server/failure-learning-context';
export { loadFailureLearningKnowledgeContext } from './server/failure-learning-context';
export type {
  CuratedAtomic,
  HubMeshAtomicInput,
  HubMeshEdge,
} from './server/hub-mesh';
export { resolveHubMeshAtomics } from './server/hub-mesh';
export type {
  CreateLearningIntentKnowledgeNodeFn,
  CreateLearningIntentKnowledgeNodeInput,
} from './server/learning-intent-knowledge';
export { createLearningIntentKnowledgeNode } from './server/learning-intent-knowledge';
export {
  archiveMisconceptionEdge,
  createMisconceptionEdge,
} from './server/misconception-edges';
export {
  type MasteryDecayBucket,
  masteryDecayBucket,
} from './server/node-page';
export type { AcceptResult as KnowledgeAcceptResult } from './server/proposals';
export {
  ACCEPT_RESULT_KINDS,
  applyArchive,
  dismissProposal,
} from './server/proposals';
export type { NameKcFn } from './server/tag-knowledge';
export { isTagKnowledgeInvariantError, tagKnowledge } from './server/tag-knowledge';
// YUK-885 — public read-model ports repointed from central deep imports.
export { isDirectTreePair } from './server/topology-gate';
export { loadTreeSnapshot } from './server/tree';
