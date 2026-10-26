import { createFileRoute } from '@tanstack/react-router';
import { Suspense, lazy } from 'react';
import {
  type IngestionSessionCreateClient,
  IngestionSessionCreateClientProvider,
  loadOnboardRecordPage,
} from '@/capabilities/onboarding/ui-public';
import { startIngestionSessionCreateClient } from '../ingestion-session-create-client';
import { StartWorkbenchShell, startNavigate } from '../workbench-shell';

const Page = lazy(() => loadOnboardRecordPage().then((defaultPage) => ({ default: defaultPage })));
const ingestionClient: IngestionSessionCreateClient = {
  createIngestionSession: startIngestionSessionCreateClient,
};
export const Route = createFileRoute('/onboarding/upload')({
  ssr: false,
  component: () => (
    <StartWorkbenchShell pathname="/onboarding/upload">
      <IngestionSessionCreateClientProvider value={ingestionClient}>
        <Suspense>
          <Page navigate={startNavigate} />
        </Suspense>
      </IngestionSessionCreateClientProvider>
    </StartWorkbenchShell>
  ),
});
