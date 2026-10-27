import { createContext, useContext } from 'react';
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
import { listQuestionMistakes, restoreQuestion, runServingAction } from './library-api';

export type LibraryClient = {
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
};
const httpLibraryClient: LibraryClient = {
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
