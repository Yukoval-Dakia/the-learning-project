// Stable server contract for consumers outside the knowledge capability.
export {
  batchResolveEffectiveDomains,
  getEffectiveDomain,
  resolveAllActiveKnowledgeIds,
  resolveSubjectKnowledgeIds,
} from './server/domain';
export { loadFailureLearningKnowledgeContext } from './server/failure-learning-context';
export type { FailureLearningKnowledgeNode } from './server/failure-learning-context';
export { loadConfusablePairs } from './server/misconception-confusable-read';
export { loadTreeSnapshot } from './server/tree';
export {
  ACCEPT_RESULT_KINDS,
  applyArchive,
  dismissProposal,
} from './server/proposals';
export type { AcceptResult as KnowledgeAcceptResult } from './server/proposals';
export {
  archiveMisconceptionEdge,
  createMisconceptionEdge,
} from './server/misconception-edges';
export {
  assertCauseAllowedForSubjectProfile,
  resolveSubjectProfileForKnowledgeIds,
  resolveSubjectProfileForKnowledgeIdsStrict,
} from './server/subject-profile';
export { isTagKnowledgeInvariantError, tagKnowledge } from './server/tag-knowledge';
export type { NameKcFn } from './server/tag-knowledge';
export {
  listKnowledgeEdges,
  listKnowledgeEdgesPage,
} from './server/edges';
export { resolveHubMeshAtomics } from './server/hub-mesh';
export type {
  CuratedAtomic,
  HubMeshAtomicInput,
  HubMeshEdge,
} from './server/hub-mesh';
export { assertKnowledgeIdsExist } from './server/validate';
export { decideKnowledgeEdgeProposal } from './server/edge-proposal-accept';
export type {
  EdgeProposalDecision,
  EdgeProposalDecisionInput,
  KnowledgeEdgeProposalDecisionResult,
} from './server/edge-proposal-accept';
export {
  batchResolveSubjectDisplayIds,
  batchResolveSubjectIds,
  resolveSubjectRenderNotation,
} from './server/subject-resolution';
