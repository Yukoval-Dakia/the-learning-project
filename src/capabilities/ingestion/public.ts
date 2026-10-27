// Stable server contract for consumers outside the ingestion capability.

export type { MistakeProjection } from './api/contracts';
export { CreateIngestionSessionBody } from './api/contracts';
export type { ColdStartBridgeRunTaskFn } from './server/cold-start-bridge';
export {
  ColdStartBridgeError,
  runColdStartBridge,
} from './server/cold-start-bridge';
// Ingestion-owned config keys expose consumer-effective facts to the admin config seam.
export { ingestionConfigEffectiveFacts } from './server/config-effective-facts';
export { createIngestionSession } from './server/create-session';
export type {
  ImageCandidateAcceptDeps,
  ImageCandidateAcceptResult,
} from './server/image-candidate-accept';
export type {
  RecordLinksAcceptResult,
  RecordPromotionAcceptResult,
} from './server/legacy-record-appliers';
export { readMistakes } from './server/mistakes-read';
export { requestIngestionOperation } from './server/operation-request';
export type { SourceAssetRow } from './server/persist-image-asset';
// The DOCX text-line session owner writes the same usage receipt as the OCR job;
// exporting the writer and vocabulary avoids deep imports of capability internals.
export type {
  IngestionRedactionField,
  IngestionUsageReceipt,
} from './server/privacy-guard';
export { writeIngestionUsageReceipt } from './server/privacy-guard';
export type { BlockMergeAcceptResult } from './server/proposal-appliers';
export {
  bodyBlockSummaries,
  excerpt,
  knowledgeContext,
} from './server/tools/record-tool-support';

// Public port, replacing a central deep import.
export {
  AUTO_ENROLL_SINGLETON_SECONDS,
  autoEnrollJobEnabled,
} from './server/workflow-judge-config';

// Task composition uses the narrow task-public entry directly.
export { ingestionTaskSpecs } from './task-public';
