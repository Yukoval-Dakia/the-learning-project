import { createContext, useContext } from 'react';
import {
  getEdgeProposals,
  getEdges,
  getMisconceptions,
  getNodePage,
  vetoMisconception,
} from './knowledge-api';

export type KnowledgeClient = {
  getEdgeProposals: typeof getEdgeProposals;
  getEdges: typeof getEdges;
  getMisconceptions: typeof getMisconceptions;
  getNodePage: typeof getNodePage;
  vetoMisconception: typeof vetoMisconception;
};
const httpKnowledgeClient: KnowledgeClient = {
  getEdgeProposals,
  getEdges,
  getMisconceptions,
  getNodePage,
  vetoMisconception,
};
const KnowledgeClientContext = createContext<KnowledgeClient | undefined>(undefined);
export const KnowledgeClientProvider = KnowledgeClientContext.Provider;
export function useKnowledgeClient(): KnowledgeClient {
  return useContext(KnowledgeClientContext) ?? httpKnowledgeClient;
}
