import { createFileRoute } from '@tanstack/react-router';
import { Suspense, lazy } from 'react';
import { loadAdminCostSurface } from '@/capabilities/observability/ui-public';
import { startAdminClient } from '../admin-client';
import { StartWorkbenchShell, startNavigate } from '../workbench-shell';

const Page = lazy(() => loadAdminCostSurface().then((defaultPage) => ({ default: defaultPage })));
export const Route = createFileRoute('/admin/cost')({
  ssr: false,
  component: () => (
    <StartWorkbenchShell pathname="/admin/cost">
      <Suspense>
        <Page navigate={startNavigate} client={startAdminClient} />
      </Suspense>
    </StartWorkbenchShell>
  ),
});
