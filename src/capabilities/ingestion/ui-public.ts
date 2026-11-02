// Client-only public contribution surface.
export const loadRecordPage = () =>
  import('./ui/record/RecordPage').then((module) => module.default);

export {
  assertLaneStarted,
  buildRecordManualMistakeBody,
  buildRecordSessionCreateBody,
  projectPurposeImpact,
  projectRecordSessionCreateResponse,
  projectRecordSessionDetailResponse,
  projectSessionBlocksResponse,
  projectSessionListResponse,
  purposeImpactUrl,
  purposeReceiptLocation,
} from './ui/record/record-api';
export { type RecordClient, RecordClientProvider } from './ui/record/record-client';
