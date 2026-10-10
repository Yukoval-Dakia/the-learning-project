import { createFileRoute } from '@tanstack/react-router';
import { Suspense, lazy } from 'react';
import { loadInboxPage } from '@/capabilities/shell/ui-public';
import { StartWorkbenchShell, startNavigate } from '../workbench-shell';

const Page = lazy(() => loadInboxPage().then((defaultPage) => ({ default: defaultPage })));
export const Route = createFileRoute('/inbox')({
  ssr: false,
  component: () => (
    <StartWorkbenchShell pathname="/inbox">
      <Suspense>
        <Page navigate={startNavigate} />
      </Suspense>
    </StartWorkbenchShell>
  ),
});
