import { createFileRoute } from '@tanstack/react-router';
import { Suspense, lazy } from 'react';
import { loadAdminRunsSurface } from '@/capabilities/observability/ui-public';
import { startAdminClient } from '../admin-client';
import { StartWorkbenchShell, startNavigate } from '../workbench-shell';

const Page = lazy(() => loadAdminRunsSurface().then((defaultPage) => ({ default: defaultPage })));
export const Route = createFileRoute('/admin/runs')({
  ssr: false,
  component: () => (
    <StartWorkbenchShell pathname="/admin/runs">
      <Suspense>
        <Page navigate={startNavigate} client={startAdminClient} />
      </Suspense>
    </StartWorkbenchShell>
  ),
});
