// Stable server contract for consumers outside the ingestion capability.

export type {
  IngestionAssessmentReceipt,
  MistakeListResponse,
  MistakeProjection,
} from './api/contracts';
export { readIngestionAssessmentReceipts } from './server/assessment-receipt';
export type { ColdStartBridgeRunTaskFn } from './server/cold-start-bridge';
export {
  ColdStartBridgeError,
  runColdStartBridge,
} from './server/cold-start-bridge';
// YUK-1007 — ingestion 拥有配置键的 consumer-effective 事实（真实 reader 调用）：
// 组合根 facts seam 聚合进 GET /api/admin/config keys[].effective。
export { ingestionConfigEffectiveFacts } from './server/config-effective-facts';
export type {
  ImageCandidateAcceptDeps,
  ImageCandidateAcceptResult,
} from './server/image-candidate-accept';
export type {
  RecordLinksAcceptResult,
  RecordPromotionAcceptResult,
} from './server/legacy-record-appliers';
export type { MistakeListQuery } from './server/mistakes-read';
export { readMistakes } from './server/mistakes-read';
export type { SourceAssetRow } from './server/persist-image-asset';
export {
  lockImageStorageKey,
  persistImageAsset,
  sha256Hex,
} from './server/persist-image-asset';
export type { BlockMergeAcceptResult } from './server/proposal-appliers';
export {
  bodyBlockSummaries,
  excerpt,
  knowledgeContext,
} from './server/tools/record-tool-support';
// YUK-885 — public port repointed from a central deep import.
export {
  AUTO_ENROLL_SINGLETON_SECONDS,
  autoEnrollJobEnabled,
} from './server/workflow-judge-config';
// YUK-1062 — task composition uses the narrow task-public entry directly.
export { ingestionTaskSpecs } from './task-public';
