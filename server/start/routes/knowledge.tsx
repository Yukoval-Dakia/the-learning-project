import { Outlet, createFileRoute, useRouterState } from '@tanstack/react-router';
import { Suspense, lazy } from 'react';
import { loadKnowledgePage } from '@/capabilities/knowledge/ui-public';
import { StartWorkbenchShell, startNavigate } from '../workbench-shell';

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
      <Suspense>
        <Page navigate={startNavigate} />
      </Suspense>
    </StartWorkbenchShell>
  );
}
