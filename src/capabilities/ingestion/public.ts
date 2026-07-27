// Stable server contract for consumers outside the ingestion capability.
export {
  ColdStartBridgeError,
  runColdStartBridge,
} from './server/cold-start-bridge';
export type { ColdStartBridgeRunTaskFn } from './server/cold-start-bridge';
export type {
  ImageCandidateAcceptDeps,
  ImageCandidateAcceptResult,
} from './server/image-candidate-accept';
export type {
  RecordLinksAcceptResult,
  RecordPromotionAcceptResult,
} from './server/legacy-record-appliers';
export type { BlockMergeAcceptResult } from './server/proposal-appliers';
