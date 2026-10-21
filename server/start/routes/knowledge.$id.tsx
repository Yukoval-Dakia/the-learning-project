import { createFileRoute } from '@tanstack/react-router';
import { Suspense, lazy } from 'react';
import { loadKnowledgeDetailPage } from '@/capabilities/knowledge/ui-public';
import { StartWorkbenchShell, startNavigate } from '../workbench-shell';

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
      <Suspense>
        <Page id={id} navigate={startNavigate} />
      </Suspense>
    </StartWorkbenchShell>
  );
}
