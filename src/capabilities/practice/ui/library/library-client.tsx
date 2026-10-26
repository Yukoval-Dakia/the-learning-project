import { createContext, useContext } from 'react';
import {
  deleteQuestion,
  getDraftDetail,
  getQuestionFull,
  getQuestionKnowledgeOptions,
  patchQuestion,
} from '../practice-api';
import { listQuestionMistakes, restoreQuestion } from './library-api';

export type LibraryClient = {
  deleteQuestion: typeof deleteQuestion;
  patchQuestion: typeof patchQuestion;
  restoreQuestion: typeof restoreQuestion;
  listQuestionMistakes: typeof listQuestionMistakes;
  getQuestionKnowledgeOptions: typeof getQuestionKnowledgeOptions;
  getDraftDetail: typeof getDraftDetail;
  getQuestionFull: (id: string) => ReturnType<typeof getQuestionFull>;
};
const httpLibraryClient: LibraryClient = {
  deleteQuestion,
  patchQuestion,
  restoreQuestion,
  listQuestionMistakes,
  getQuestionKnowledgeOptions,
  getDraftDetail,
  getQuestionFull: (id) => getQuestionFull(id),
};
const LibraryClientContext = createContext<LibraryClient | undefined>(undefined);
export const LibraryClientProvider = LibraryClientContext.Provider;
export function useLibraryClient(): LibraryClient {
  return useContext(LibraryClientContext) ?? httpLibraryClient;
}
