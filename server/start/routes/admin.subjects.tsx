import { Outlet, createFileRoute, useRouterState } from '@tanstack/react-router';
import { Suspense, lazy } from 'react';
import { loadAdminSubjectsSurface } from '@/capabilities/observability/ui-public';
import { startAdminControlClient } from '../admin-control-client';
import { StartWorkbenchShell, startNavigate } from '../workbench-shell';

const Page = lazy(() =>
  loadAdminSubjectsSurface().then((defaultPage) => ({ default: defaultPage })),
);
export const Route = createFileRoute('/admin/subjects')({
  ssr: false,
  component: SubjectsPage,
});
function SubjectsPage() {
  const hasDetail = useRouterState({
    select: (state) => state.matches.some((match) => match.routeId === '/admin/subjects/$id'),
  });
  if (hasDetail) return <Outlet />;
  return (
    <StartWorkbenchShell pathname="/admin/subjects">
      <Suspense>
        <Page navigate={startNavigate} client={startAdminControlClient} />
      </Suspense>
    </StartWorkbenchShell>
  );
}
