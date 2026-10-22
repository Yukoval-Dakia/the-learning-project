import { createFileRoute } from '@tanstack/react-router';
import { Suspense, lazy } from 'react';
import {
  type PlacementClient,
  PlacementClientProvider,
  httpPlacementClient,
  loadPlacementPage,
} from '@/capabilities/onboarding/ui-public';
import { startPlacementSessionClient } from '../placement-session-client';
import { StartWorkbenchShell, startNavigate } from '../workbench-shell';

const Page = lazy(() => loadPlacementPage().then((defaultPage) => ({ default: defaultPage })));
const placementClient: PlacementClient = {
  ...httpPlacementClient,
  getPlacementSession: startPlacementSessionClient,
};
export const Route = createFileRoute('/placement')({
  ssr: false,
  component: () => (
    <StartWorkbenchShell pathname="/placement">
      <PlacementClientProvider value={placementClient}>
        <Suspense>
          <Page navigate={startNavigate} />
        </Suspense>
      </PlacementClientProvider>
    </StartWorkbenchShell>
  ),
});
