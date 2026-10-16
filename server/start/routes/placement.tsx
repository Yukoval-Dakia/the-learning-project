import { createFileRoute } from '@tanstack/react-router';
import { Suspense, lazy } from 'react';
import { loadPlacementPage } from '@/capabilities/onboarding/ui-public';
import { StartWorkbenchShell, startNavigate } from '../workbench-shell';

const Page = lazy(() => loadPlacementPage().then((defaultPage) => ({ default: defaultPage })));
export const Route = createFileRoute('/placement')({
  ssr: false,
  component: () => (
    <StartWorkbenchShell pathname="/placement">
      <Suspense>
        <Page navigate={startNavigate} />
      </Suspense>
    </StartWorkbenchShell>
  ),
});
