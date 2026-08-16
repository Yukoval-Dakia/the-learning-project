// Stable server contract for consumers outside the ingestion capability.

export type { ColdStartBridgeRunTaskFn } from './server/cold-start-bridge';
export {
  ColdStartBridgeError,
  runColdStartBridge,
} from './server/cold-start-bridge';
export type {
  ImageCandidateAcceptDeps,
  ImageCandidateAcceptResult,
} from './server/image-candidate-accept';
export type {
  RecordLinksAcceptResult,
  RecordPromotionAcceptResult,
} from './server/legacy-record-appliers';
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
