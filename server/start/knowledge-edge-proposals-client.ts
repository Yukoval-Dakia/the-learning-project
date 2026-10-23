import type { KnowledgeClient } from '@/capabilities/knowledge/ui-public';
import { authenticatedStartFetch } from './authenticated-fetch';
import { getStartProposalInbox } from './workbench-function';

export const startKnowledgeEdgeProposalsClient: KnowledgeClient['getEdgeProposals'] = async () => {
  const response = JSON.parse(
    await getStartProposalInbox({
      fetch: authenticatedStartFetch,
      data: { kind: 'knowledge_edge', status: 'pending' },
    }),
  );
  return { rows: response.rows };
};
