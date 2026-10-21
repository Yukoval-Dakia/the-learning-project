import { createFileRoute } from '@tanstack/react-router';
import { Suspense, lazy } from 'react';
import { loadCoachHub } from '@/capabilities/shell/ui-public';
import { StartWorkbenchShell, startNavigate } from '../workbench-shell';

const Page = lazy(() => loadCoachHub().then((defaultPage) => ({ default: defaultPage })));
export const Route = createFileRoute('/coach')({
  ssr: false,
  component: () => (
    <StartWorkbenchShell pathname="/coach">
      <Suspense>
        <Page navigate={startNavigate} />
      </Suspense>
    </StartWorkbenchShell>
  ),
});
