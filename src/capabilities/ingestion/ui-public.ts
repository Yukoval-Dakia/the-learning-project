// Client-only public contribution surface.
export const loadRecordPage = () => import('./ui/RecordPage').then((module) => module.default);
