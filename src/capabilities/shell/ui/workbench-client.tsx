import { createContext, useContext } from 'react';
import { getTree } from '@/capabilities/knowledge/ui-public';
import { type ApiOperationJsonResponse, apiJson } from '@/ui/lib/api';
import {
  decideProposal,
  listAutoApplied,
  listDecisionProposalPage,
  listObservationProposalPreview,
  retractProposal,
} from './inbox-api';
import { getPrepDeskConjectures } from './prep-desk-api';
import {
  getOvernightDigest,
  getRecentAiChanges,
  getWorkbenchSummary,
  undoAiChange,
} from './workbench-api';

export type WorkbenchClient = {
  getWorkbenchSummary: typeof getWorkbenchSummary;
  getOvernightDigest: typeof getOvernightDigest;
  getTodayCost: () => Promise<ApiOperationJsonResponse<'getTodayCost'>>;
  listDecisionProposalPage: typeof listDecisionProposalPage;
  listObservationProposalPreview: typeof listObservationProposalPreview;
  listAutoApplied: typeof listAutoApplied;
  decideProposal: typeof decideProposal;
  retractProposal: typeof retractProposal;
  getTree: typeof getTree;
  getPrepDeskConjectures: typeof getPrepDeskConjectures;
  getRecentAiChanges: typeof getRecentAiChanges;
  undoAiChange: typeof undoAiChange;
};
export const httpWorkbenchClient: WorkbenchClient = {
  getWorkbenchSummary: () => getWorkbenchSummary(),
  getOvernightDigest: () => getOvernightDigest(),
  getTodayCost: () => apiJson<ApiOperationJsonResponse<'getTodayCost'>>('/api/cost/today'),
  listDecisionProposalPage: (...args) => listDecisionProposalPage(...args),
  listObservationProposalPreview: () => listObservationProposalPreview(),
  listAutoApplied: () => listAutoApplied(),
  decideProposal: (...args) => decideProposal(...args),
  retractProposal: (...args) => retractProposal(...args),
  getTree: () => getTree(),
  getPrepDeskConjectures: () => getPrepDeskConjectures(),
  getRecentAiChanges: () => getRecentAiChanges(),
  undoAiChange: (...args) => undoAiChange(...args),
};
const WorkbenchClientContext = createContext<WorkbenchClient | undefined>(undefined);
export const WorkbenchClientProvider = WorkbenchClientContext.Provider;

// Resolve defaults at render time so existing HTTP consumers and test seams keep working.
export function useWorkbenchClient(): WorkbenchClient {
  return useContext(WorkbenchClientContext) ?? httpWorkbenchClient;
}
