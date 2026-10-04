// Stable server contract for consumers outside the knowledge capability.
//
// YUK-876 / FULL F3.7b — the failure-attempt evidence + attribution read models
// (moved from src/server/events/queries.ts) are part of this contract.

// YUK-885 — public read-model ports repointed from central deep imports.
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
// YUK-1064 — script and cross-capability integration ports.
export { runKnowledgeEdgeProposeNightly } from './jobs/knowledge_edge_propose_nightly';
// YUK-1007 — knowledge 拥有配置键的 consumer-effective 事实（真实 reader 调用）：
// 组合根 facts seam 聚合进 GET /api/admin/config keys[].effective。
export { knowledgeConfigEffectiveFacts } from './server/config-effective-facts';
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
export type {
  FailureLearningKnowledgeNode,
  FailureLearningMisconceptionNode,
} from './server/failure-learning-context';
export {
  getMisconceptionsByIds,
  listActiveMisconceptionsForKcs,
  loadFailureLearningKnowledgeContext,
} from './server/failure-learning-context';
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
export { createKnowledgeNodeFromEvents } from './server/node-creation';
export {
  type MasteryDecayBucket,
  masteryDecayBucket,
} from './server/node-page';
export type { AcceptResult as KnowledgeAcceptResult } from './server/proposals';
export {
  ACCEPT_RESULT_KINDS,
  acceptProposal,
  dismissProposal,
  writeKnowledgeProposeEvent,
} from './server/proposals';
export type { RubricGate } from './server/rubric-validator';
export { seedKnowledge } from './server/seed';
export type { NameKcFn } from './server/tag-knowledge';
export { isTagKnowledgeInvariantError, tagKnowledge } from './server/tag-knowledge';
export { loadTreeSnapshot } from './server/tree';
