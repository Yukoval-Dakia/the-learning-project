import { createFileRoute } from '@tanstack/react-router';
import { Suspense, lazy } from 'react';
import { loadWelcomePage } from '@/capabilities/onboarding/ui-public';
import { StartWorkbenchShell, startNavigate } from '../workbench-shell';

const Page = lazy(() => loadWelcomePage().then((defaultPage) => ({ default: defaultPage })));
export const Route = createFileRoute('/welcome')({
  ssr: false,
  component: () => (
    <StartWorkbenchShell pathname="/welcome">
      <Suspense>
        <Page navigate={startNavigate} />
      </Suspense>
    </StartWorkbenchShell>
  ),
});
