// Client-only public contribution surface.
export const loadRecordPage = () =>
  import('./ui/record/RecordPage').then((module) => module.default);
