// Client-only public contribution surface.

export type { QuestionDetail } from './ui/practice-api';
export {
  computeLatencyMs,
  getQuestion,
  saveResponseDraft,
} from './ui/practice-api';

export const loadPracticeFacePage = () =>
  import('./ui/PracticeFacePage').then((module) => module.default);
/** YUK-1473 — same props; the solve view renders in the new design language (TEST preview). */
export const loadPracticeNextPage = () =>
  import('./ui/PracticeFacePage').then((module) => module.PracticeNextPage);
export type { PracticeFacePageProps } from './ui/PracticeFacePage';
export const loadDraftReviewPage = () =>
  import('./ui/DraftReviewPage').then((module) => module.default);
export const loadQuestionsPage = () =>
  import('./ui/QuestionsPage').then((module) => module.default);
export const loadQuestionDetailPage = () =>
  import('./ui/QuestionDetailPage').then((module) => module.default);
