import { createFileRoute } from '@tanstack/react-router';
import { Suspense, lazy } from 'react';
import {
  type KnowledgeClient,
  KnowledgeClientProvider,
  loadKnowledgeDetailPage,
} from '@/capabilities/knowledge/ui-public';
import { startKnowledgeEdgeCreateClient } from '../knowledge-edge-create-client';
import { startKnowledgeEdgeProposalsClient } from '../knowledge-edge-proposals-client';
import { startKnowledgeEdgesClient } from '../knowledge-edges-client';
import { startKnowledgeMisconceptionsClient } from '../knowledge-misconceptions-client';
import { startKnowledgeNodePageClient } from '../knowledge-node-client';
import { startWorkbenchClient } from '../workbench-client';
import { StartWorkbenchShell, startNavigate } from '../workbench-shell';

const knowledgeClient: KnowledgeClient = {
  createEdge: startKnowledgeEdgeCreateClient,
  decideEdgeProposal: (id, decision, newRelationType) =>
    startWorkbenchClient.decideProposal(id, decision, { newRelationType }),
  getEdgeProposals: startKnowledgeEdgeProposalsClient,
  getEdges: startKnowledgeEdgesClient,
  getMisconceptions: startKnowledgeMisconceptionsClient,
  getNodePage: startKnowledgeNodePageClient,
  vetoMisconception: (id) => startWorkbenchClient.decideProposal(id, 'dismiss'),
};

const Page = lazy(() =>
  loadKnowledgeDetailPage().then((defaultPage) => ({ default: defaultPage })),
);
export const Route = createFileRoute('/knowledge/$id')({
  ssr: false,
  component: KnowledgeDetailPage,
});

function KnowledgeDetailPage() {
  const { id } = Route.useParams();
  return (
    <StartWorkbenchShell pathname={`/knowledge/${encodeURIComponent(id)}`}>
      <KnowledgeClientProvider value={knowledgeClient}>
        <Suspense>
          <Page id={id} navigate={startNavigate} />
        </Suspense>
      </KnowledgeClientProvider>
    </StartWorkbenchShell>
  );
}
