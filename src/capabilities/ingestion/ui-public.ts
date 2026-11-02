// Client-only public contribution surface.
export const loadRecordPage = () =>
  import('./ui/record/RecordPage').then((module) => module.default);

export {
  buildRecordManualMistakeBody,
  buildRecordSessionCreateBody,
  projectRecordSessionCreateResponse,
  projectRecordSessionDetailResponse,
  projectSessionBlocksResponse,
  projectSessionListResponse,
} from './ui/record/record-api';
export { type RecordClient, RecordClientProvider } from './ui/record/record-client';
