// Client-only public contribution surface.

export type { QuestionDetail } from './ui/practice-api';
export {
  buildPaperSubmissionBody,
  computeLatencyMs,
  getQuestion,
  projectQuestionDeleteResponse,
  saveResponseDraft,
} from './ui/practice-api';
export { type PracticeClient, PracticeClientProvider } from './ui/practice-client';

export const loadPracticeFacePage = () =>
  import('./ui/PracticeFacePage').then((module) => module.default);
// YUK-1473 — 题目: one library (all / mistakes / review / held) and one question page.
export type { LibraryPageProps } from './ui/library/LibraryPage';
export const loadQuestionLibraryPage = () =>
  import('./ui/library/LibraryPage').then((module) => module.default);
export const loadQuestionPage = () =>
  import('./ui/library/QuestionPage').then((module) => module.default);
export const loadWorksheetPrintPage = () =>
  import('./ui/worksheet/WorksheetPrintPage').then((module) => module.default);

export { type LibraryClient, LibraryClientProvider } from './ui/library/library-client';
