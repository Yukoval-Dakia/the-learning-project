import { createContext, useContext } from 'react';
import { getDraftDetail, getQuestionFull } from '../practice-api';

export type LibraryClient = {
  getDraftDetail: typeof getDraftDetail;
  getQuestionFull: (id: string) => ReturnType<typeof getQuestionFull>;
};
const httpLibraryClient: LibraryClient = {
  getDraftDetail,
  getQuestionFull: (id) => getQuestionFull(id),
};
const LibraryClientContext = createContext<LibraryClient | undefined>(undefined);
export const LibraryClientProvider = LibraryClientContext.Provider;
export function useLibraryClient(): LibraryClient {
  return useContext(LibraryClientContext) ?? httpLibraryClient;
}
