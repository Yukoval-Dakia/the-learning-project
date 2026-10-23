import { createContext, useContext } from 'react';
import { getMisconceptions, getNodePage, vetoMisconception } from './knowledge-api';

export type KnowledgeClient = {
  getMisconceptions: typeof getMisconceptions;
  getNodePage: typeof getNodePage;
  vetoMisconception: typeof vetoMisconception;
};
const httpKnowledgeClient: KnowledgeClient = { getMisconceptions, getNodePage, vetoMisconception };
const KnowledgeClientContext = createContext<KnowledgeClient | undefined>(undefined);
export const KnowledgeClientProvider = KnowledgeClientContext.Provider;
export function useKnowledgeClient(): KnowledgeClient {
  return useContext(KnowledgeClientContext) ?? httpKnowledgeClient;
}
