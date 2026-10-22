import { createContext, useContext } from 'react';
import { getMisconceptions } from './knowledge-api';

export type KnowledgeClient = {
  getMisconceptions: typeof getMisconceptions;
};
const httpKnowledgeClient: KnowledgeClient = { getMisconceptions };
const KnowledgeClientContext = createContext<KnowledgeClient | undefined>(undefined);
export const KnowledgeClientProvider = KnowledgeClientContext.Provider;
export function useKnowledgeClient(): KnowledgeClient {
  return useContext(KnowledgeClientContext) ?? httpKnowledgeClient;
}
