import { createFileRoute } from '@tanstack/react-router';
import { Suspense, lazy } from 'react';
import { loadOnboardRecordPage } from '@/capabilities/onboarding/ui-public';
import { StartWorkbenchShell, startNavigate } from '../workbench-shell';

const Page = lazy(() => loadOnboardRecordPage().then((defaultPage) => ({ default: defaultPage })));
export const Route = createFileRoute('/onboarding/upload')({
  ssr: false,
  component: () => (
    <StartWorkbenchShell pathname="/onboarding/upload">
      <Suspense>
        <Page navigate={startNavigate} />
      </Suspense>
    </StartWorkbenchShell>
  ),
});
