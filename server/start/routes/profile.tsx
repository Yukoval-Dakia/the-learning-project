import { createFileRoute } from '@tanstack/react-router';
import { Suspense, lazy } from 'react';
import { loadPlacementProfilePage } from '@/capabilities/onboarding/ui-public';
import { StartWorkbenchShell, startNavigate } from '../workbench-shell';

const Page = lazy(() => loadPlacementProfilePage().then((defaultPage) => ({ default: defaultPage })));
export const Route = createFileRoute('/profile')({
  ssr: false,
  component: () => (
    <StartWorkbenchShell pathname="/profile">
      <Suspense>
        <Page navigate={startNavigate} />
      </Suspense>
    </StartWorkbenchShell>
  ),
});
