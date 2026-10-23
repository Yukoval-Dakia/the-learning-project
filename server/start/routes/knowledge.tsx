import { Outlet, createFileRoute, useRouterState } from '@tanstack/react-router';
import { Suspense, lazy } from 'react';
import {
  type KnowledgeClient,
  KnowledgeClientProvider,
  loadKnowledgePage,
} from '@/capabilities/knowledge/ui-public';
import { startKnowledgeMisconceptionsClient } from '../knowledge-misconceptions-client';
import { startKnowledgeNodePageClient } from '../knowledge-node-client';
import {
  startKnowledgeFrontierClient,
  startKnowledgeReviewDueClient,
  startWorkbenchClient,
} from '../workbench-client';
import { StartWorkbenchShell, startNavigate } from '../workbench-shell';

const knowledgeClient: KnowledgeClient = {
  getMisconceptions: startKnowledgeMisconceptionsClient,
  getNodePage: startKnowledgeNodePageClient,
  vetoMisconception: (id) => startWorkbenchClient.decideProposal(id, 'dismiss'),
};

const Page = lazy(() => loadKnowledgePage().then((defaultPage) => ({ default: defaultPage })));
export const Route = createFileRoute('/knowledge')({
  ssr: false,
  component: KnowledgePage,
});

function KnowledgePage() {
  const hasDetail = useRouterState({
    select: (state) => state.matches.some((match) => match.routeId === '/knowledge/$id'),
  });
  if (hasDetail) return <Outlet />;
  return (
    <StartWorkbenchShell pathname="/knowledge">
      <KnowledgeClientProvider value={knowledgeClient}>
        <Suspense>
          <Page
            navigate={startNavigate}
            readTree={startWorkbenchClient.getTree}
            readFrontier={startKnowledgeFrontierClient}
            readReviewDue={startKnowledgeReviewDueClient}
          />
        </Suspense>
      </KnowledgeClientProvider>
    </StartWorkbenchShell>
  );
}
