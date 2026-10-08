import { createFileRoute } from '@tanstack/react-router';
import { Suspense, lazy } from 'react';
import { loadAdminCoverageLatticeSurface } from '@/capabilities/observability/ui-public';
import { startAdminClient } from '../admin-client';
import { StartWorkbenchShell, startNavigate } from '../workbench-shell';

const Page = lazy(() =>
  loadAdminCoverageLatticeSurface().then((defaultPage) => ({ default: defaultPage })),
);
export const Route = createFileRoute('/admin/coverage-lattice')({
  ssr: false,
  component: () => (
    <StartWorkbenchShell pathname="/admin/coverage-lattice">
      <Suspense>
        <Page navigate={startNavigate} client={startAdminClient} />
      </Suspense>
    </StartWorkbenchShell>
  ),
});
