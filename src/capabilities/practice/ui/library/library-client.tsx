import { createContext, useContext } from 'react';
import type { CurrentPublishedQuestionVersion } from '@/kernel/read-models/question-card';
import {
  deleteQuestion,
  enableDraft,
  forceEnableDraft,
  getDraftDetail,
  getQuestionFull,
  getQuestionKnowledgeOptions,
  getQuestionsList,
  patchQuestion,
} from '../practice-api';
import {
  getReviewDrafts,
  listMistakes,
  listQuestionMistakes,
  restoreQuestion,
  runServingAction,
} from './library-api';

export type LibraryClient = {
  listMistakes: typeof listMistakes;
  getReviewDrafts: typeof getReviewDrafts;
  getQuestionsList: typeof getQuestionsList;
  enableDraft: typeof enableDraft;
  forceEnableDraft: typeof forceEnableDraft;
  runServingAction: typeof runServingAction;
  deleteQuestion: typeof deleteQuestion;
  patchQuestion: typeof patchQuestion;
  restoreQuestion: typeof restoreQuestion;
  listQuestionMistakes: typeof listQuestionMistakes;
  getQuestionKnowledgeOptions: typeof getQuestionKnowledgeOptions;
  getDraftDetail: typeof getDraftDetail;
  getQuestionFull: (id: string) => ReturnType<typeof getQuestionFull>;
  getPublishedQuestionVersion?: (id: string) => Promise<CurrentPublishedQuestionVersion>;
};
const httpLibraryClient: LibraryClient = {
  listMistakes,
  getReviewDrafts,
  enableDraft,
  forceEnableDraft,
  runServingAction,
  deleteQuestion,
  patchQuestion,
  restoreQuestion,
  listQuestionMistakes,
  getQuestionKnowledgeOptions,
  getQuestionsList,
  getDraftDetail,
  getQuestionFull: (id) => getQuestionFull(id),
};
const LibraryClientContext = createContext<LibraryClient | undefined>(undefined);
export const LibraryClientProvider = LibraryClientContext.Provider;
export function useLibraryClient(): LibraryClient {
  return useContext(LibraryClientContext) ?? httpLibraryClient;
}
