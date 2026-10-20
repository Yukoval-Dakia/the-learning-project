// Client-only public contribution surface.
export type { MistakeListResponse, MistakeProjection } from './ui/mistakes-api';
export { listMistakes } from './ui/mistakes-api';
export const loadRecordPage = () =>
  import('./ui/record/RecordPage').then((module) => module.default);
