import { createContext, useContext } from 'react';
import { getDraftDetail, getQuestionFull, getQuestionKnowledgeOptions } from '../practice-api';

export type LibraryClient = {
  getQuestionKnowledgeOptions: typeof getQuestionKnowledgeOptions;
  getDraftDetail: typeof getDraftDetail;
  getQuestionFull: (id: string) => ReturnType<typeof getQuestionFull>;
};
const httpLibraryClient: LibraryClient = {
  getQuestionKnowledgeOptions,
  getDraftDetail,
  getQuestionFull: (id) => getQuestionFull(id),
};
const LibraryClientContext = createContext<LibraryClient | undefined>(undefined);
export const LibraryClientProvider = LibraryClientContext.Provider;
export function useLibraryClient(): LibraryClient {
  return useContext(LibraryClientContext) ?? httpLibraryClient;
}
