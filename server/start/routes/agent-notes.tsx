import { createFileRoute } from '@tanstack/react-router';
import { Suspense, lazy } from 'react';
import { loadAgentNotesPage } from '@/capabilities/agency/ui-public';
import { StartWorkbenchShell, startNavigate } from '../workbench-shell';

const Page = lazy(() => loadAgentNotesPage().then((defaultPage) => ({ default: defaultPage })));
export const Route = createFileRoute('/agent-notes')({
  ssr: false,
  component: () => (
    <StartWorkbenchShell pathname="/agent-notes">
      <Suspense>
        <Page navigate={startNavigate} />
      </Suspense>
    </StartWorkbenchShell>
  ),
});
