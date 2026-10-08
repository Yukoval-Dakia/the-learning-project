import { createFileRoute } from '@tanstack/react-router';
import { Suspense, lazy } from 'react';
import { loadTodayPage } from '@/capabilities/shell/ui-public';
import { StartWorkbenchShell, startNavigate } from '../workbench-shell';

const Page = lazy(() => loadTodayPage().then((defaultPage) => ({ default: defaultPage })));
export const Route = createFileRoute('/today')({
  ssr: false,
  component: () => (
    <StartWorkbenchShell pathname="/today">
      <Suspense>
        <Page navigate={startNavigate} />
      </Suspense>
    </StartWorkbenchShell>
  ),
});
