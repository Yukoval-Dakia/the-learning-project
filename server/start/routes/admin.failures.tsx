import { createFileRoute } from '@tanstack/react-router';
import { Suspense, lazy } from 'react';
import { loadAdminFailuresSurface } from '@/capabilities/observability/ui-public';
import { startAdminClient } from '../admin-client';
import { StartWorkbenchShell, startNavigate } from '../workbench-shell';

const Page = lazy(() =>
  loadAdminFailuresSurface().then((defaultPage) => ({ default: defaultPage })),
);
export const Route = createFileRoute('/admin/failures')({
  ssr: false,
  component: () => (
    <StartWorkbenchShell pathname="/admin/failures">
      <Suspense>
        <Page navigate={startNavigate} client={startAdminClient} />
      </Suspense>
    </StartWorkbenchShell>
  ),
});
