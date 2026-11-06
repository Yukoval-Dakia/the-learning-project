import { createFileRoute } from '@tanstack/react-router';
import { Suspense, lazy } from 'react';
import { loadMemoryPage } from '@/capabilities/agency/ui-public';
import { StartWorkbenchShell } from '../workbench-shell';

const Page = lazy(() => loadMemoryPage().then((defaultPage) => ({ default: defaultPage })));
export const Route = createFileRoute('/memory')({
  ssr: false,
  component: () => (
    <StartWorkbenchShell pathname="/memory">
      <Suspense>
        <Page />
      </Suspense>
    </StartWorkbenchShell>
  ),
});
