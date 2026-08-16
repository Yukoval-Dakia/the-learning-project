// Client-only public contribution surface.

export type { QuestionDetail } from './ui/practice-api';
export {
  computeLatencyMs,
  getQuestion,
} from './ui/practice-api';

export const loadPracticeFacePage = () =>
  import('./ui/PracticeFacePage').then((module) => module.default);
export const loadDraftReviewPage = () =>
  import('./ui/DraftReviewPage').then((module) => module.default);
export const loadQuestionsPage = () =>
  import('./ui/QuestionsPage').then((module) => module.default);
export const loadQuestionDetailPage = () =>
  import('./ui/QuestionDetailPage').then((module) => module.default);
