import { createFileRoute } from '@tanstack/react-router';
import { Suspense, lazy } from 'react';
import { loadAdminConjectureScoresSurface } from '@/capabilities/observability/ui-public';
import { startAdminClient } from '../admin-client';
import { StartWorkbenchShell, startNavigate } from '../workbench-shell';

const Page = lazy(() =>
  loadAdminConjectureScoresSurface().then((defaultPage) => ({ default: defaultPage })),
);
export const Route = createFileRoute('/admin/conjecture-scores')({
  ssr: false,
  component: () => (
    <StartWorkbenchShell pathname="/admin/conjecture-scores">
      <Suspense>
        <Page navigate={startNavigate} client={startAdminClient} />
      </Suspense>
    </StartWorkbenchShell>
  ),
});
