import { createContext, useContext } from 'react';
import { getMisconceptions, getNodePage } from './knowledge-api';

export type KnowledgeClient = {
  getMisconceptions: typeof getMisconceptions;
  getNodePage: typeof getNodePage;
};
const httpKnowledgeClient: KnowledgeClient = { getMisconceptions, getNodePage };
const KnowledgeClientContext = createContext<KnowledgeClient | undefined>(undefined);
export const KnowledgeClientProvider = KnowledgeClientContext.Provider;
export function useKnowledgeClient(): KnowledgeClient {
  return useContext(KnowledgeClientContext) ?? httpKnowledgeClient;
}
